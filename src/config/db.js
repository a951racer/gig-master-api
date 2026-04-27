const mongoose = require('mongoose');

const connectDB = async () => {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
};

module.exports = connectDB;
