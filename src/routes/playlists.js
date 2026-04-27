const express = require('express');
const Playlist = require('../models/Playlist');
const Song = require('../models/Song');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.use(authenticate);

// GET /playlists — all playlists with song count (no full song docs)
router.get('/', async (req, res, next) => {
  try {
    const playlists = await Playlist.find().lean();
    const result = playlists.map((p) => ({ ...p, songCount: p.songs.length }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /playlists — create
router.post('/', async (req, res, next) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      const err = new Error('name is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { name: 'required' };
      return next(err);
    }

    const playlist = new Playlist({ name, description });
    await playlist.save();
    res.status(201).json(playlist);
  } catch (err) {
    next(err);
  }
});

// GET /playlists/:id — with songs fully populated (including genre)
router.get('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id).populate({
      path: 'songs',
      populate: { path: 'genre', select: '_id name slug' },
    });
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// PATCH /playlists/:id — update metadata (songs NOT populated)
router.patch('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { name, description } = req.body;
    if (name !== undefined) playlist.name = name;
    if (description !== undefined) playlist.description = description;

    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    await playlist.deleteOne();
    res.json({ message: 'Playlist deleted' });
  } catch (err) {
    next(err);
  }
});

// POST /playlists/:id/songs — add a song
router.post('/:id/songs', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { songId } = req.body;
    const song = await Song.findById(songId);
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    playlist.songs.push(songId);
    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

// DELETE /playlists/:id/songs/:songId — remove a song
router.delete('/:id/songs/:songId', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    playlist.songs.pull(req.params.songId);
    await playlist.save();
    res.json({ message: 'Song removed from playlist' });
  } catch (err) {
    next(err);
  }
});

// PUT /playlists/:id/songs — reorder (full replacement, must match current set)
router.put('/:id/songs', async (req, res, next) => {
  try {
    const playlist = await Playlist.findById(req.params.id);
    if (!playlist) {
      const err = new Error('Playlist not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { songs } = req.body;
    const currentIds = playlist.songs.map((id) => id.toString()).sort();
    const submittedIds = (songs || []).map((id) => id.toString()).sort();

    if (
      currentIds.length !== submittedIds.length ||
      currentIds.some((id, i) => id !== submittedIds[i])
    ) {
      const err = new Error('Song list does not match current playlist songs');
      err.status = 422;
      err.code = 'SONGS_MISMATCH';
      return next(err);
    }

    playlist.songs = songs;
    await playlist.save();
    res.json(playlist);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
