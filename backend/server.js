require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';
const OPENLIBRARY_API_URL = process.env.OPENLIBRARY_API_URL || 'https://openlibrary.org/api/books';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDatabase();
  }
});

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const DEFAULT_COVERS = {
  'ISBN-1': 'https://covers.openlibrary.org/b/isbn/9780143039693-M.jpg',
  'ISBN-2': 'https://covers.openlibrary.org/b/isbn/9780143106395-M.jpg',
  'ISBN-3': 'https://covers.openlibrary.org/b/isbn/9780132350884-M.jpg',
  'ISBN-4': 'https://covers.openlibrary.org/b/isbn/9780078022159-M.jpg',
  'ISBN-5': 'https://covers.openlibrary.org/b/isbn/9780262033848-M.jpg',
  'ISBN-6': 'https://covers.openlibrary.org/b/isbn/9781449373320-M.jpg'
};

async function initDatabase() {
  try {
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        isbn TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL,
        total_copies INTEGER NOT NULL DEFAULT 1,
        avail_copies INTEGER NOT NULL DEFAULT 1,
        cover_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbRun(`
      CREATE TABLE IF NOT EXISTS borrowings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        book_id INTEGER NOT NULL,
        borrow_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        due_date DATETIME NOT NULL,
        return_date DATETIME,
        status TEXT NOT NULL DEFAULT 'Borrowed',
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (book_id) REFERENCES books(id)
      )
    `);

    // Keep Admin Portal account only; students register their own accounts
    const adminHash = await bcrypt.hash('gwapoko123', 10);
    await dbRun(
      'INSERT OR IGNORE INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      ['Admin Portal', 'admin123', adminHash, 'admin']
    );

    // Seed Sample Books with simple ISBNs (ISBN-1 to ISBN-6) and real cover URLs
    const bookCount = await dbGet('SELECT COUNT(*) AS count FROM books');
    if (bookCount.count === 0) {
      const sampleBooks = [
        ['Noli Me Tangere', 'Jose Rizal', 'ISBN-1', 'Literature', 5, 5, DEFAULT_COVERS['ISBN-1']],
        ['El Filibusterismo', 'Jose Rizal', 'ISBN-2', 'Literature', 4, 4, DEFAULT_COVERS['ISBN-2']],
        ['Clean Code', 'Robert C. Martin', 'ISBN-3', 'Information Technology', 3, 3, DEFAULT_COVERS['ISBN-3']],
        ['Database System Concepts', 'Abraham Silberschatz', 'ISBN-4', 'Information Technology', 4, 4, DEFAULT_COVERS['ISBN-4']],
        ['Introduction to Algorithms', 'Thomas H. Cormen', 'ISBN-5', 'Computer Science', 2, 2, DEFAULT_COVERS['ISBN-5']],
        ['Designing Data-Intensive Applications', 'Martin Kleppmann', 'ISBN-6', 'Information Technology', 3, 3, DEFAULT_COVERS['ISBN-6']]
      ];
      for (const b of sampleBooks) {
        await dbRun(
          'INSERT INTO books (title, author, isbn, category, total_copies, avail_copies, cover_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
          b
        );
      }
    } else {
      // Backfill cover images if existing rows have empty cover_url
      for (const [isbn, url] of Object.entries(DEFAULT_COVERS)) {
        await dbRun(
          "UPDATE books SET cover_url = ? WHERE isbn = ? AND (cover_url IS NULL OR cover_url = '')",
          [url, isbn]
        );
      }
    }
  } catch (err) {
    console.error('Database initialization failed:', err.message);
  }
}

function broadcastUpdate(event, payload) {
  const message = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'CONNECTED', payload: { message: 'Live library feed connected' } }));
});

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

function authorizeAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden. Admin privileges required.' });
  }
  next();
}

// Register Student Account (Name, Username, Password)
app.post('/api/register', async (req, res) => {
  try {
    const { full_name, email, password } = req.body;
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Name, username, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const cleanUsername = email.trim().toLowerCase();
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [cleanUsername]);
    if (existing) return res.status(400).json({ error: 'That username is already taken.' });

    const assignedRole = 'user';
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [full_name.trim(), cleanUsername, passwordHash, assignedRole]
    );

    res.status(201).json({
      message: 'Student account created! You can now log in.',
      user: { id: result.id, full_name: full_name.trim(), email: cleanUsername, role: assignedRole }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// Login (Admin or Registered Student)
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const loginInput = email.trim().toLowerCase();
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [loginInput]);
    if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid username or password.' });

    const token = jwt.sign(
      { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.status(200).json({
      message: 'Login successful.',
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// Open Library ISBN Lookup
app.get('/api/books/lookup/:isbn', authenticateToken, async (req, res) => {
  try {
    const cleanIsbn = req.params.isbn.replace(/[^0-9X]/gi, '');
    if (!cleanIsbn) return res.status(400).json({ error: 'Valid ISBN is required.' });

    const apiUrl = `${OPENLIBRARY_API_URL}?bibkeys=ISBN:${cleanIsbn}&format=json&jscmd=data`;
    const response = await fetch(apiUrl);
    if (!response.ok) return res.status(502).json({ error: 'Failed to reach Open Library API.' });

    const data = await response.json();
    const bookData = data[`ISBN:${cleanIsbn}`];
    if (!bookData) return res.status(404).json({ error: 'No book found on Open Library for this ISBN.' });

    res.status(200).json({
      isbn: cleanIsbn,
      title: bookData.title || 'Unknown Title',
      author: bookData.authors && bookData.authors.length > 0 ? bookData.authors[0].name : 'Unknown Author',
      cover_url: bookData.cover ? bookData.cover.medium : '',
      publish_date: bookData.publish_date || 'N/A'
    });
  } catch (err) {
    res.status(500).json({ error: 'Error fetching metadata from Open Library.' });
  }
});

// Get Books (supports ?search= and ?category=)
app.get('/api/books', authenticateToken, async (req, res) => {
  try {
    const { search, category } = req.query;
    let sql = 'SELECT * FROM books WHERE 1=1';
    const params = [];

    if (category && category.trim() !== '' && category.trim().toLowerCase() !== 'all') {
      sql += ' AND LOWER(category) = LOWER(?)';
      params.push(category.trim());
    }

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ? OR category LIKE ?)';
      params.push(term, term, term, term);
    }

    sql += ' ORDER BY id ASC';
    const books = await dbAll(sql, params);
    res.status(200).json(books);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve books.' });
  }
});

app.get('/api/books/:id', authenticateToken, async (req, res) => {
  try {
    const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    res.status(200).json(book);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve book.' });
  }
});

// Add Book (Admin)
app.post('/api/books', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const { title, author, isbn, category, total_copies, cover_url } = req.body;
    if (!title || !author || !isbn || !category) {
      return res.status(400).json({ error: 'Title, author, ISBN, and category are required.' });
    }
    const copies = parseInt(total_copies, 10) || 1;
    if (copies < 1) return res.status(400).json({ error: 'Total copies must be at least 1.' });

    const cleanIsbn = isbn.trim();
    const existing = await dbGet('SELECT id FROM books WHERE isbn = ?', [cleanIsbn]);
    if (existing) return res.status(400).json({ error: 'A book with this ISBN already exists.' });

    const result = await dbRun(
      'INSERT INTO books (title, author, isbn, category, total_copies, avail_copies, cover_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title.trim(), author.trim(), cleanIsbn, category.trim(), copies, copies, (cover_url || '').trim()]
    );

    const newBook = await dbGet('SELECT * FROM books WHERE id = ?', [result.id]);
    broadcastUpdate('BOOK_ADDED', newBook);
    res.status(201).json(newBook);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add book.' });
  }
});

// Update Book (Admin)
app.put('/api/books/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'Book not found.' });

    const { title, author, isbn, category, total_copies, avail_copies, cover_url } = req.body;
    if (!title || !author || !isbn || !category) {
      return res.status(400).json({ error: 'Title, author, ISBN, and category are required.' });
    }

    const newTotal = total_copies !== undefined ? parseInt(total_copies, 10) : book.total_copies;
    const newAvail = avail_copies !== undefined ? parseInt(avail_copies, 10) : book.avail_copies;

    if (newTotal < 1 || newAvail < 0 || newAvail > newTotal) {
      return res.status(400).json({ error: 'Invalid copy counts.' });
    }

    await dbRun(
      'UPDATE books SET title = ?, author = ?, isbn = ?, category = ?, total_copies = ?, avail_copies = ?, cover_url = ? WHERE id = ?',
      [title.trim(), author.trim(), isbn.trim(), category.trim(), newTotal, newAvail, (cover_url || '').trim(), req.params.id]
    );

    const updatedBook = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    broadcastUpdate('BOOK_UPDATED', updatedBook);
    res.status(200).json(updatedBook);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update book.' });
  }
});

// Delete Book (Admin)
app.delete('/api/books/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const book = await dbGet('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (!book) return res.status(404).json({ error: 'Book not found.' });

    const activeBorrow = await dbGet(
      "SELECT id FROM borrowings WHERE book_id = ? AND status = 'Borrowed'",
      [req.params.id]
    );
    if (activeBorrow) {
      return res.status(400).json({ error: 'Cannot delete book while copies are currently borrowed.' });
    }

    await dbRun('DELETE FROM books WHERE id = ?', [req.params.id]);
    broadcastUpdate('BOOK_DELETED', { id: parseInt(req.params.id, 10) });
    res.status(200).json({ message: 'Book deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete book.' });
  }
});

// Borrowings
app.get('/api/borrowings', authenticateToken, async (req, res) => {
  try {
    let rows;
    if (req.user.role === 'admin') {
      rows = await dbAll(`
        SELECT b.id, b.borrow_date, b.due_date, b.return_date, b.status,
               u.full_name AS borrower_name, u.email AS borrower_username,
               bk.id AS book_id, bk.title AS book_title, bk.isbn
        FROM borrowings b
        JOIN users u ON b.user_id = u.id
        JOIN books bk ON b.book_id = bk.id
        ORDER BY b.id DESC
      `);
    } else {
      rows = await dbAll(`
        SELECT b.id, b.borrow_date, b.due_date, b.return_date, b.status,
               u.full_name AS borrower_name,
               bk.id AS book_id, bk.title AS book_title, bk.isbn
        FROM borrowings b
        JOIN users u ON b.user_id = u.id
        JOIN books bk ON b.book_id = bk.id
        WHERE b.user_id = ?
        ORDER BY b.id DESC
      `, [req.user.id]);
    }
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load borrowing records.' });
  }
});

app.post('/api/borrowings', authenticateToken, async (req, res) => {
  try {
    const { book_id, days } = req.body;
    if (!book_id) return res.status(400).json({ error: 'book_id is required.' });

    const book = await dbGet('SELECT * FROM books WHERE id = ?', [book_id]);
    if (!book) return res.status(404).json({ error: 'Book not found.' });
    if (book.avail_copies < 1) return res.status(400).json({ error: 'No available copies left to borrow.' });

    const alreadyBorrowed = await dbGet(
      "SELECT id FROM borrowings WHERE user_id = ? AND book_id = ? AND status = 'Borrowed'",
      [req.user.id, book_id]
    );
    if (alreadyBorrowed) {
      return res.status(400).json({ error: 'You already have an active borrow for this book.' });
    }

    const borrowDays = parseInt(days, 10) > 0 ? parseInt(days, 10) : 7;
    const dueDate = new Date(Date.now() + borrowDays * 24 * 60 * 60 * 1000).toISOString();

    const result = await dbRun(
      'INSERT INTO borrowings (user_id, book_id, due_date, status) VALUES (?, ?, ?, ?)',
      [req.user.id, book_id, dueDate, 'Borrowed']
    );

    await dbRun('UPDATE books SET avail_copies = avail_copies - 1 WHERE id = ?', [book_id]);

    const record = await dbGet(`
      SELECT b.id, b.borrow_date, b.due_date, b.status,
             u.full_name AS borrower_name, bk.id AS book_id, bk.title AS book_title, bk.isbn, bk.avail_copies
      FROM borrowings b
      JOIN users u ON b.user_id = u.id
      JOIN books bk ON b.book_id = bk.id
      WHERE b.id = ?
    `, [result.id]);

    broadcastUpdate('BOOK_BORROWED', record);
    res.status(201).json({ message: 'Book borrowed successfully.', borrowing: record });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process borrowing request.' });
  }
});

app.put('/api/borrowings/:id/return', authenticateToken, async (req, res) => {
  try {
    const borrowing = await dbGet('SELECT * FROM borrowings WHERE id = ?', [req.params.id]);
    if (!borrowing) return res.status(404).json({ error: 'Borrowing record not found.' });
    if (req.user.role !== 'admin' && borrowing.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden. You cannot return another user’s book.' });
    }
    if (borrowing.status === 'Returned') {
      return res.status(400).json({ error: 'This book has already been returned.' });
    }

    const returnDate = new Date().toISOString();
    await dbRun(
      "UPDATE borrowings SET status = 'Returned', return_date = ? WHERE id = ?",
      [returnDate, req.params.id]
    );
    await dbRun('UPDATE books SET avail_copies = avail_copies + 1 WHERE id = ?', [borrowing.book_id]);

    broadcastUpdate('BOOK_RETURNED', { borrowing_id: borrowing.id, book_id: borrowing.book_id });
    res.status(200).json({ message: 'Book returned successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to return book.' });
  }
});

// Delete All Completed Borrowing Records (Admin) - placed before /:id so 'returned' isn't treated as an ID
app.delete('/api/borrowings/returned', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const result = await dbRun("DELETE FROM borrowings WHERE status = 'Returned'");
    res.status(200).json({
      message: `Deleted ${result.changes} completed borrowing record(s).`,
      deletedCount: result.changes
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete completed borrowing records.' });
  }
});

// Delete Completed Borrowing Record (Admin)
app.delete('/api/borrowings/:id', authenticateToken, authorizeAdmin, async (req, res) => {
  try {
    const borrowing = await dbGet('SELECT * FROM borrowings WHERE id = ?', [req.params.id]);
    if (!borrowing) return res.status(404).json({ error: 'Borrowing record not found.' });
    if (borrowing.status === 'Borrowed') {
      return res.status(400).json({ error: 'Return the book first before deleting this record.' });
    }

    await dbRun('DELETE FROM borrowings WHERE id = ?', [req.params.id]);
    res.status(200).json({ message: 'Borrowing record deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete borrowing record.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

server.listen(PORT, () => {
  console.log(`LCC LibTrack server running at http://localhost:${PORT}`);
});