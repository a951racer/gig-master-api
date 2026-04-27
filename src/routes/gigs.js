const express = require('express');
const Gig = require('../models/Gig');
const Playlist = require('../models/Playlist');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.use(authenticate);

// GET /gigs — all gigs sorted by date descending, playlist name only
router.get('/', async (req, res, next) => {
  try {
    const gigs = await Gig.find()
      .sort({ date: -1 })
      .populate('playlist', '_id name');
    res.json(gigs);
  } catch (err) {
    next(err);
  }
});

// POST /gigs — create
router.post('/', async (req, res, next) => {
  try {
    const { name, description, location, date, playlist } = req.body;

    if (!name) {
      const err = new Error('name is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { name: 'required' };
      return next(err);
    }

    if (!date) {
      const err = new Error('date is required');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.fields = { date: 'required' };
      return next(err);
    }

    if (playlist) {
      const playlistDoc = await Playlist.findById(playlist);
      if (!playlistDoc) {
        const err = new Error('Invalid playlist');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { playlist: 'Invalid playlist' };
        return next(err);
      }
    }

    const gig = new Gig({ name, description, location, date, playlist: playlist || null });
    await gig.save();
    res.status(201).json(gig);
  } catch (err) {
    next(err);
  }
});

// GET /gigs/:id — full gig with playlist populated (songs + genre)
router.get('/:id', async (req, res, next) => {
  try {
    const gig = await Gig.findById(req.params.id).populate({
      path: 'playlist',
      populate: {
        path: 'songs',
        populate: { path: 'genre', select: '_id name slug' },
      },
    });
    if (!gig) {
      const err = new Error('Gig not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }
    res.json(gig);
  } catch (err) {
    next(err);
  }
});

// PATCH /gigs/:id — partial update
router.patch('/:id', async (req, res, next) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      const err = new Error('Gig not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    const { name, description, location, date, playlist } = req.body;

    if ('playlist' in req.body && playlist !== null && playlist !== undefined) {
      const playlistDoc = await Playlist.findById(playlist);
      if (!playlistDoc) {
        const err = new Error('Invalid playlist');
        err.status = 422;
        err.code = 'VALIDATION_ERROR';
        err.fields = { playlist: 'Invalid playlist' };
        return next(err);
      }
    }

    if (name !== undefined) gig.name = name;
    if (description !== undefined) gig.description = description;
    if (location !== undefined) gig.location = location;
    if (date !== undefined) gig.date = date;
    if ('playlist' in req.body) gig.playlist = playlist || null;

    await gig.save();
    res.json(gig);
  } catch (err) {
    next(err);
  }
});

// DELETE /gigs/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) {
      const err = new Error('Gig not found');
      err.status = 404;
      err.code = 'NOT_FOUND';
      return next(err);
    }

    await gig.deleteOne();
    res.json({ message: 'Gig deleted' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
