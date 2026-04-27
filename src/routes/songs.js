const express = require('express');
const mongoose = require('mongoose');
const Song = require('../models/Song');
const Genre = require('../models/Genre');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.use(authenticate);

// GET /songs — list with optional filters
router.get('/', async (req, res, next) => {
  try {
    const { title, genre, tags } = req.query;
    const filter = {};

    if (title) {
      filter.title = { $regex: title, $options: 'i' };
    }

    if (genre) {
      filter.genre = genre;
    }

    if (tags) {
      const tagsArray = tags.split(',').map((t) => t.trim()).filter(Boolean);
      if (tagsArray.length > 0) {
        filter.tags = { $all: tagsArray };
      }
    }

    const songs = await Song.find(filter).populate('genre', '_id name slug');
    res.json(songs);
  } catch (err) {
    next(err);
  }
});

// POST /songs — create
router.post('/', async (req, res, next) => {
  try {
    const { title, artist, genre, tags, originalKey, performedKey } = req.body;

    if (!title) {
      const err = new Error('title is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { title: 'required' };
      return next(err);
    }

    if (!artist) {
      const err = new Error('artist is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { artist: 'required' };
      return next(err);
    }

    if (genre) {
      const genreDoc = await Genre.findById(genre);
      if (!genreDoc) {
        const err = new Error('Invalid genre');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { genre: 'Invalid genre' };
        return next(err);
      }
    }

    const song = new Song({ title, artist, genre: genre || null, tags, originalKey, performedKey });
    await song.save();
    await song.populate('genre', '_id name slug');

    res.status(201).json(song);
  } catch (err) {
    next(err);
  }
});

// GET /songs/:id
router.get('/:id', async (req, res, next) => {
  try {
    const song = await Song.findById(req.params.id).populate('genre', '_id name slug');
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    res.json(song);
  } catch (err) {
    next(err);
  }
});

// PATCH /songs/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { title, artist, genre, tags, originalKey, performedKey } = req.body;

    if ('genre' in req.body && genre !== null && genre !== undefined) {
      const genreDoc = await Genre.findById(genre);
      if (!genreDoc) {
        const err = new Error('Invalid genre');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { genre: 'Invalid genre' };
        return next(err);
      }
    }

    if (title !== undefined) song.title = title;
    if (artist !== undefined) song.artist = artist;
    if ('genre' in req.body) song.genre = genre || null;
    if (tags !== undefined) song.tags = tags;
    if (originalKey !== undefined) song.originalKey = originalKey;
    if (performedKey !== undefined) song.performedKey = performedKey;

    await song.save();
    await song.populate('genre', '_id name slug');

    res.json(song);
  } catch (err) {
    next(err);
  }
});

// DELETE /songs/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) {
      const err = new Error('Song not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    await song.deleteOne();
    res.json({ message: 'Song deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
