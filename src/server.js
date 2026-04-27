require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/db');
const seedGenres = require('./config/seedGenres');

const PORT = process.env.PORT || 3001;

connectDB()
  .then(() => seedGenres())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
