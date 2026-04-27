const express = require('express');
const router = express.Router();
const Genre = require('../models/Genre');
const Song = require('../models/Song');
const authenticate = require('../middleware/authenticate');

function generateSlug(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /genres — public
router.get('/', async (req, res, next) => {
  try {
    const genres = await Genre.find({}, { _id: 1, name: 1, slug: 1 }).sort({ name: 1 });
    res.json(genres);
  } catch (err) {
    next(err);
  }
});

// POST /genres — requires auth
router.post('/', authenticate, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      const err = new Error('Validation failed');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { name: 'Name is required' };
      return next(err);
    }

    const escapedName = escapeRegex(name.trim());
    const existing = await Genre.findOne({ name: { $regex: new RegExp('^' + escapedName + '$', 'i') } });
    if (existing) {
      const err = new Error('Genre already exists');
      err.status = 409;
      err.code = 'CONFLICT';
      return next(err);
    }

    const slug = generateSlug(name);
    const genre = await Genre.create({ name: name.trim(), slug });
    res.status(201).json({ _id: genre._id, name: genre.name, slug: genre.slug });
  } catch (err) {
    next(err);
  }
});

// PATCH /genres/:id — requires auth
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const genre = await Genre.findById(req.params.id);
    if (!genre) {
      const err = new Error('Genre not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { name } = req.body;
    if (!name || !name.trim()) {
      const err = new Error('Validation failed');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { name: 'Name is required' };
      return next(err);
    }

    const escapedName = escapeRegex(name.trim());
    const existing = await Genre.findOne({
      name: { $regex: new RegExp('^' + escapedName + '$', 'i') },
      _id: { $ne: genre._id },
    });
    if (existing) {
      const err = new Error('Genre already exists');
      err.status = 409;
      err.code = 'CONFLICT';
      return next(err);
    }

    genre.name = name.trim();
    genre.slug = generateSlug(name);
    await genre.save();

    res.json({ _id: genre._id, name: genre.name, slug: genre.slug });
  } catch (err) {
    next(err);
  }
});

// DELETE /genres/:id — requires auth
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const genre = await Genre.findById(req.params.id);
    if (!genre) {
      const err = new Error('Genre not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const songUsingGenre = await Song.findOne({ genre: req.params.id });
    if (songUsingGenre) {
      return res.status(409).json({
        error: { code: 'GENRE_IN_USE', message: 'Genre is in use by one or more songs' },
      });
    }

    await genre.deleteOne();
    res.json({ message: 'Genre deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
