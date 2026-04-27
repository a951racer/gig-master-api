const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRouter = require('./routes/auth');
const genresRouter = require('./routes/genres');
const songsRouter = require('./routes/songs');
const playlistsRouter = require('./routes/playlists');
const gigsRouter = require('./routes/gigs');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRouter);
app.use('/genres', genresRouter);
app.use('/songs', songsRouter);
app.use('/playlists', playlistsRouter);
app.use('/gigs', gigsRouter);

app.use(errorHandler);

module.exports = app;
