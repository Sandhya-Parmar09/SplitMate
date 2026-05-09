const User = require('../models/User');  
const Trip = require('../models/Trip');
const FriendRequest = require('../models/FriendRequest');




// controllers/tripController.js
exports.createTrip = async (req, res) => {
  try {
    let { title, memberUsernames } = req.body;

    // Validate title
    title = String(title).trim();
    if (!title || title.length === 0) {
      return res.status(400).json({ message: "Trip title is required" });
    }

    if (!Array.isArray(memberUsernames) || memberUsernames.length === 0) {
      return res.status(400).json({ message: "At least one member is required" });
    }

    // 1. Fetch all members
    const members = await User.find({ username: { $in: memberUsernames } });

    if (members.length !== memberUsernames.length) {
      return res.status(400).json({ message: "Some usernames are invalid or not registered" });
    }

    // 2. Convert to IDs
    let memberIds = members.map(m => m._id.toString());

    // 2. Include trip creator
    if (!memberIds.includes(req.user.id)) {
      memberIds.push(req.user.id);
      // Also push the creator's User object to members
      const creator = await User.findById(req.user.id);
      if (creator) members.push(creator);
    }

    // 3. Sort by username
    members.sort((a, b) => a.username.localeCompare(b.username));
    memberIds = members.map(m => m._id);

    // Initialize balanceMatrix as a zero matrix
    const n = memberIds.length;
    const balanceMatrix = Array(n).fill().map(() => Array(n).fill(0));

    const trip = new Trip({ title, members: memberIds, createdBy: req.user.id, balanceMatrix });
    await trip.save();

    res.status(201).json({ message: "Trip created successfully!", tripId: trip._id, title: trip.title });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// Get all trips of the logged-in user
exports.getUserTrips = async (req, res) => {
  try {
    const userId = req.user.id;

    const trips = await Trip.find({ members: userId })
      .select('title members createdAt updatedAt')
      .populate('members', 'username name')
      .sort({ createdAt: -1 });

    res.status(200).json(trips);  // Array of trips
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


exports.getTripDetails = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.tripId)
      .populate('members', 'username name'); // populate kar raha hai
    if (!trip) return res.status(404).json({ message: "Trip not found" });

  // 🔐 Check if logged-in user is a trip member
    const isMember = trip.members.some(
      member => member._id.toString() === req.user.id
    );

    if (!isMember) {
      return res.status(403).json({ message: "You are not part of this trip" });
    }

    res.status(200).json(trip); // trip ke members ke saath
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpenses = async (req, res) => {
  const { tripId } = req.params;
  try {
    const trip = await Trip.findById(tripId).populate(
      'expenses.paidBy.user',
      'username name'
    ).populate(
      'expenses.splitBetween',
      'username name'
    );

    if (!trip) return res.status(404).json({ message: "Trip not found" });

 // 🔐 Check if logged-in user is a trip member
    const isMember = trip.members.some(
      member => member.toString() === req.user.id
    );

    if (!isMember) {
      return res.status(403).json({ message: "You are not part of this trip" });
    }

    // Sort by most recent
    trip.expenses.sort((a, b) => b._id.getTimestamp() - a._id.getTimestamp());

    res.status(200).json(trip.expenses);  // array of expenses
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};





// Helper function to update balanceMatrix

  function updateBalanceMatrix(trip, expense) {
  const members = trip.members;
  const n = members.length;

  if (!trip.balanceMatrix || trip.balanceMatrix.length !== n) {
    trip.balanceMatrix = Array(n).fill().map(() => Array(n).fill(0));
  }

  // Step 1: Track how much each member paid
  const paid = Array(n).fill(0);
  expense.paidBy.forEach(payer => {
    const idx = members.findIndex(m => m.equals(payer.user));
    if (idx === -1) {
      console.error(`Warning: Payer ${payer.user} not found in trip members`);
      return; // Skip if not found
    }
    paid[idx] += payer.amount;
  });

  // Step 2: Calculate how much each member should pay (equal split)
  const perShare = expense.amount / expense.splitBetween.length;
  const owes = Array(n).fill(0);
  expense.splitBetween.forEach(splitUser => {
    const idx = members.findIndex(m => m.equals(splitUser));
    if (idx === -1) {
      console.error(`Warning: Split user ${splitUser} not found in trip members`);
      return; // Skip if not found
    }
    owes[idx] = perShare;
  });

  // Step 3: Calculate net balance: positive = owed money, negative = owes money
  const netBalance = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    netBalance[i] = paid[i] - owes[i];
  }

  // Step 4: Update matrix - debtors pay creditors proportionally
  // Find creditors (positive balance) and debtors (negative balance)
  const creditors = [];
  const debtors = [];
  for (let i = 0; i < n; i++) {
    if (netBalance[i] > 0) creditors.push({ idx: i, amount: netBalance[i] });
    if (netBalance[i] < 0) debtors.push({ idx: i, amount: -netBalance[i] });
  }

  // Debtors pay creditors proportionally to their credit amount
  const totalCredit = creditors.reduce((sum, c) => sum + c.amount, 0);
  if (totalCredit > 0) {
    debtors.forEach(debtor => {
      creditors.forEach(creditor => {
        const proportion = creditor.amount / totalCredit;
        const amountOwed = debtor.amount * proportion;
        trip.balanceMatrix[debtor.idx][creditor.idx] += amountOwed;
        trip.balanceMatrix[creditor.idx][debtor.idx] -= amountOwed;
      });
    });
  }

  return trip.balanceMatrix;
}


// Add expense to trip
exports.addExpense = async (req, res) => {
  try {
    const { tripId } = req.params;
    let { description, amount, paidBy, splitBetween, category } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    // Convert amount to number
    amount = Number(amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount must be a positive number" });
    }

    // Validate trip members
    const tripMembers = trip.members.map(m => m.toString());
    if (!tripMembers.includes(req.user.id)) {
      return res.status(403).json({ message: "You are not a member of this trip" });
    }
    // Validate trip members
    const allUserIds = [...paidBy.map(p => p.user), ...splitBetween];
    for (let uid of allUserIds) {
      if (!tripMembers.includes(uid)) {
        return res.status(400).json({ message: `User ${uid} is not part of the trip` });
      }
    }

    // Convert paidBy amounts to numbers
    paidBy = paidBy.map(p => ({
      user: p.user,
      amount: Number(p.amount)
    })).filter(p => p.amount > 0);

    if (paidBy.length === 0) {
      return res.status(400).json({ message: "At least one person must pay" });
    }

    if (splitBetween.length === 0) {
      return res.status(400).json({ message: "Expense must be split among at least one person" });
    }

    // Validate sum of paidBy
    const totalPaid = paidBy.reduce((sum, p) => sum + p.amount, 0);
    if (Math.abs(totalPaid - amount) > 0.01) { // Allow 0.01 for float precision
      return res.status(400).json({ 
        message: `Total paid (${totalPaid}) must equal expense amount (${amount})` 
      });
    }

    // Push new expense
    const newExpense = { description, amount, paidBy, splitBetween, category };
    trip.expenses.push(newExpense);

    // Update balanceMatrix
    updateBalanceMatrix(trip, newExpense);

    await trip.save();

    return res.status(201).json({ 
      message: "Expense added & balance updated!",
      balanceMatrix: trip.balanceMatrix 
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get balance matrix
exports.getBalanceMatrix = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

 // 🔐 Check if logged-in user is a trip member
    const isMember = trip.members.some(
      member => member.toString() === req.user.id
    );

    if (!isMember) {
      return res.status(403).json({ message: "You are not part of this trip" });
    }

    return res.status(200).json({ balanceMatrix: trip.balanceMatrix });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Get a single expense by ID
exports.getExpenseById = async (req, res) => {
  try {
    const { tripId, expenseId } = req.params;

    const trip = await Trip.findById(tripId)
      .populate('expenses.paidBy.user', 'username name')
      .populate('expenses.splitBetween', 'username name');

    if (!trip) return res.status(404).json({ message: "Trip not found" });

    const expense = trip.expenses.id(expenseId); // Mongo subdocument search
    if (!expense) return res.status(404).json({ message: "Expense not found" });
    // ✅ Authorization check: allow any trip member
    const loggedInUserId = req.user.id;
    const isTripMember = trip.members.some(m => m.equals(loggedInUserId));
    if (!isTripMember) {
      return res.status(403).json({ message: "Not authorized to view this expense" });
    }

    res.status(200).json(expense); // Return the expense
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Edit expense
exports.editExpense = async (req, res) => {
  try {
    const { tripId, expenseId } = req.params;
    let { description, amount, paidBy, splitBetween, category } = req.body;

    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    // Check auth: any trip member can edit
    if (!trip.members.some(m => m.equals(req.user.id))) {
      return res.status(403).json({ message: "You're not a member of this trip" });
    }

    // Find expense
    const expenseIndex = trip.expenses.findIndex(e => e._id.equals(expenseId));
    if (expenseIndex === -1) return res.status(404).json({ message: "Expense not found" });

    // Convert amount to number
    amount = Number(amount);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: "Amount must be a positive number" });
    }

    // Validate trip members
    const tripMembers = trip.members.map(m => m.toString());
    const allUserIds = [...paidBy.map(p => p.user), ...splitBetween];
    for (let uid of allUserIds) {
      if (!tripMembers.includes(uid)) {
        return res.status(400).json({ message: `User ${uid} is not part of the trip` });
      }
    }

    // Convert paidBy amounts to numbers
    paidBy = paidBy.map(p => ({
      user: p.user,
      amount: Number(p.amount)
    })).filter(p => p.amount > 0);

    if (paidBy.length === 0) {
      return res.status(400).json({ message: "At least one person must pay" });
    }

    if (splitBetween.length === 0) {
      return res.status(400).json({ message: "Expense must be split among at least one person" });
    }

    // Validate paidBy sum
    const totalPaid = paidBy.reduce((sum, p) => sum + p.amount, 0);
    if (Math.abs(totalPaid - amount) > 0.01) {
      return res.status(400).json({ message: "Total paid must equal expense amount" });
    }

    // Edit expense using Object.assign to preserve subdocument
    Object.assign(trip.expenses[expenseIndex], { description, amount, paidBy, splitBetween, category });

    // Recalculate balanceMatrix from scratch
    trip.balanceMatrix = Array(trip.members.length).fill().map(() => Array(trip.members.length).fill(0));
    trip.expenses.forEach(exp => updateBalanceMatrix(trip, exp));
    await trip.save();

    res.status(200).json({ message: "Expense updated successfully", balanceMatrix: trip.balanceMatrix });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete expense
exports.deleteExpense = async (req, res) => {
  try {
    const { tripId, expenseId } = req.params;
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    // Check auth
    if (!trip.members.some(m => m.equals(req.user.id))) {
      return res.status(403).json({ message: "You're not a member of this trip" });
    }

    const index = trip.expenses.findIndex(e => e._id.equals(expenseId));
    if (index === -1) return res.status(404).json({ message: "Expense not found" });

    // Remove expense
    trip.expenses.splice(index, 1);

    // Reset balanceMatrix
    trip.balanceMatrix = Array(trip.members.length).fill().map(() => Array(trip.members.length).fill(0));
    trip.expenses.forEach(exp => updateBalanceMatrix(trip, exp));
    await trip.save();

    res.status(200).json({ message: "Expense deleted successfully", balanceMatrix: trip.balanceMatrix });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// Get my personal balances within a trip
exports.getMyBalancesInTrip = async (req, res) => {
  try {
    const { tripId } = req.params;
    const userId = req.user.id;

    // Fetch trip & members
    const trip = await Trip.findById(tripId).populate('members', 'username name');
    if (!trip) return res.status(404).json({ message: "Trip not found" });

    // Check if user is in trip
    const index = trip.members.findIndex(m => m._id.equals(userId));
    if (index === -1) return res.status(403).json({ message: "You are not part of this trip" });

    let balances;
    if (!trip.balanceMatrix || !Array.isArray(trip.balanceMatrix) || trip.balanceMatrix.length !== trip.members.length) {
      // No expenses yet, return all other members with balance 0
      balances = trip.members.map((member, i) => {
        if (i === index) return null;
        return {
          userId: member._id,
          username: member.username,
          name: member.name,
          balance: 0
        };
      }).filter(b => b !== null);
    } else {
      // Compute balances from matrix
      balances = trip.members.map((member, i) => {
        if (i === index) return null; // skip self
        return {
          userId: member._id,
          username: member.username,
          name: member.name,
          balance: trip.balanceMatrix[index][i], // balance w.rt this member
        };
      }).filter(b => b !== null);
    }

    res.status(200).json(balances);  // array of { userId, username, name, balance }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// Get trip-wise category expenses
exports.getTripCategoryExpenses = async (req, res) => {
  const { tripId } = req.params;
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: 'Trip not found' });

    let categoryTotals = {};
    let totalExpense = 0;

    trip.expenses.forEach(exp => {
      totalExpense += exp.amount;
      categoryTotals[exp.category] = (categoryTotals[exp.category] || 0) + exp.amount;
    });

    const categories = Object.keys(categoryTotals).map(category => ({
      category,
      amount: categoryTotals[category],
    }));

    return res.status(200).json({ totalExpense, categories });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


// Get category-wise expenses for a user in a particular trip
exports.getUserCategoryExpensesInTrip = async (req, res) => {
  const { tripId} = req.params;
  const userId=req.user.id;
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) return res.status(404).json({ message: 'Trip not found' });

    let categoryTotals = {};
    let totalUserExpense = 0;

    trip.expenses.forEach(exp => {
      if (exp.splitBetween.some(u => u.equals(userId))) {
        const perShare = exp.amount / exp.splitBetween.length;
        totalUserExpense += perShare;
        categoryTotals[exp.category] = (categoryTotals[exp.category] || 0) + perShare;
      }
    });

    const categories = Object.keys(categoryTotals).map(category => ({
      category,
      amount: categoryTotals[category],
    }));

    return res.status(200).json({ totalUserExpense, categories });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


// Get trip expense summary by member
exports.getTripMembersExpenseSummary = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId)
      .populate('members', 'username name')
      .populate('expenses'); // Load expenses too

    if (!trip) return res.status(404).json({ message: "Trip not found" });

    // Prepare summary
    const summary = trip.members.map(member => {
      let total = 0;
      trip.expenses.forEach(expense => {
        if (expense.splitBetween.map(u => u.toString()).includes(member._id.toString())) {
          total += expense.amount / expense.splitBetween.length;
        }
      });
      return {
        memberId: member._id,
        memberName: member.name,
        totalExpenseByThatMember: total
      };
    });

    return res.status(200).json({
      tripTitle: trip.title,
      summary // [{ memberId, memberName, totalExpenseByThatMember }, ...]
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


// Get total expense amount for a particular trip
exports.getTripTotalExpense = async (req, res) => {
  try {
    const { tripId } = req.params;
    const trip = await Trip.findById(tripId);

    if (!trip) {
      return res.status(404).json({ message: "Trip not found" });
    }

    const totalExpense = trip.expenses.reduce((sum, expense) => sum + expense.amount, 0);

    return res.status(200).json({ tripTitle: trip.title, totalExpense });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
