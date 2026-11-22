const API_BASE = '/api';
let token = localStorage.getItem('token') || null;
let currentUser = JSON.parse(localStorage.getItem('user') || 'null');
let allBooks = [];
let selectedCategory = 'All';

const BOOK_SVG = `
  <svg xmlns="http://www.w3.org/2000/svg" width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#1e3a8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
    <line x1="8" y1="7" x2="16" y2="7"></line>
    <line x1="8" y1="11" x2="14" y2="11"></line>
  </svg>
`;

function ensureDeleteAllReturnedButton() {
  let btn = document.getElementById('deleteAllReturnedBtn');
  if (btn) return btn;

  const heading = document.getElementById('borrowingsHeading');
  const tbody = document.getElementById('borrowingsBody');
  const table = tbody ? tbody.closest('table') : null;
  if (!heading || !table || !table.parentNode) return null;

  const wrapper = document.createElement('div');
  wrapper.id = 'borrowingsHeaderBar';
  wrapper.style.display = 'flex';
  wrapper.style.justifyContent = 'space-between';
  wrapper.style.alignItems = 'center';
  wrapper.style.gap = '12px';
  wrapper.style.flexWrap = 'wrap';
  wrapper.style.marginBottom = '10px';

  heading.parentNode.insertBefore(wrapper, heading);
  heading.style.margin = '0';
  wrapper.appendChild(heading);

  btn = document.createElement('button');
  btn.id = 'deleteAllReturnedBtn';
  btn.type = 'button';
  btn.className = 'btn btn-danger';
  btn.textContent = 'Delete All Returned';
  btn.onclick = deleteAllReturnedBorrowings;
  wrapper.appendChild(btn);

  return btn;
}

function showAlert(message, type = 'success') {
  const box = document.getElementById('alertBox');
  box.textContent = message;
  box.className = `alert ${type}`;
  setTimeout(() => box.classList.add('hidden'), 4000);
}

async function apiFetch(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}`);
  const badge = document.getElementById('wsStatus');

  ws.onopen = () => {
    badge.textContent = 'Live Sync ON';
    badge.className = 'badge online';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (['BOOK_ADDED', 'BOOK_UPDATED', 'BOOK_DELETED', 'BOOK_BORROWED', 'BOOK_RETURNED'].includes(msg.event)) {
      if (token) {
        loadBooks();
        loadBorrowings();
      }
    }
  };

  ws.onclose = () => {
    badge.textContent = 'Reconnecting...';
    badge.className = 'badge offline';
    setTimeout(connectWebSocket, 3000);
  };
}

document.getElementById('tabRegister').onclick = () => {
  document.getElementById('tabRegister').classList.add('active');
  document.getElementById('tabLogin').classList.remove('active');
  document.getElementById('registerForm').classList.remove('hidden');
  document.getElementById('loginForm').classList.add('hidden');
};

document.getElementById('tabLogin').onclick = () => {
  document.getElementById('tabLogin').classList.add('active');
  document.getElementById('tabRegister').classList.remove('active');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('registerForm').classList.add('hidden');
};

document.getElementById('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const resData = await apiFetch('/register', {
      method: 'POST',
      body: JSON.stringify({
        full_name: document.getElementById('regName').value,
        email: document.getElementById('regEmail').value,
        password: document.getElementById('regPassword').value
      })
    });
    const savedUsername = document.getElementById('regEmail').value.trim();
    document.getElementById('registerForm').reset();
    showAlert(resData.message || 'Student registered! Please log in.');
    document.getElementById('tabLogin').click();
    document.getElementById('loginEmail').value = savedUsername;
    document.getElementById('loginPassword').focus();
  } catch (err) {
    showAlert(err.message, 'error');
  }
};

document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const data = await apiFetch('/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value
      })
    });
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(currentUser));
    showAlert(`Welcome, ${currentUser.full_name}!`);
    renderApp();
  } catch (err) {
    showAlert(err.message, 'error');
  }
};

document.getElementById('logoutBtn').onclick = () => {
  token = null;
  currentUser = null;
  selectedCategory = 'All';
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  renderApp();
};

document.getElementById('lookupBtn').onclick = async () => {
  const isbn = document.getElementById('isbnLookupInput').value.trim();
  if (!isbn) return showAlert('Enter an ISBN first.', 'error');
  try {
    const info = await apiFetch(`/books/lookup/${isbn}`);
    document.getElementById('bookTitle').value = info.title;
    document.getElementById('bookAuthor').value = info.author;
    document.getElementById('bookIsbn').value = info.isbn;
    document.getElementById('bookCover').value = info.cover_url;
    showAlert('Book details fetched from Open Library API!');
  } catch (err) {
    showAlert(err.message, 'error');
  }
};

document.getElementById('bookForm').onsubmit = async (e) => {
  e.preventDefault();
  const editId = document.getElementById('editBookId').value;
  const payload = {
    title: document.getElementById('bookTitle').value,
    author: document.getElementById('bookAuthor').value,
    isbn: document.getElementById('bookIsbn').value,
    category: document.getElementById('bookCategory').value,
    total_copies: parseInt(document.getElementById('bookCopies').value, 10),
    cover_url: document.getElementById('bookCover').value
  };

  try {
    if (editId) {
      await apiFetch(`/books/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showAlert('Book updated successfully.');
    } else {
      await apiFetch('/books', { method: 'POST', body: JSON.stringify(payload) });
      showAlert('Book added to library!');
    }
    resetBookForm();
    loadBooks();
  } catch (err) {
    showAlert(err.message, 'error');
  }
};

function startEditBook(book) {
  document.getElementById('bookFormTitle').textContent = `Edit Book: ${book.title}`;
  document.getElementById('editBookId').value = book.id;
  document.getElementById('bookTitle').value = book.title;
  document.getElementById('bookAuthor').value = book.author;
  document.getElementById('bookIsbn').value = book.isbn;
  document.getElementById('bookCategory').value = book.category;
  document.getElementById('bookCopies').value = book.total_copies;
  document.getElementById('bookCover').value = book.cover_url || '';
  document.getElementById('cancelEditBtn').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetBookForm() {
  document.getElementById('bookFormTitle').textContent = 'Add New Book (Admin Portal)';
  document.getElementById('editBookId').value = '';
  document.getElementById('bookForm').reset();
  document.getElementById('cancelEditBtn').classList.add('hidden');
}

document.getElementById('cancelEditBtn').onclick = resetBookForm;

// Delete Book (Admin)
async function deleteBook(id) {
  if (!confirm('Delete this book?')) return;
  try {
    await apiFetch(`/books/${id}`, { method: 'DELETE' });
    showAlert('Book deleted.');
    loadBooks();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

// Delete Completed Borrowing Record (Admin)
async function deleteBorrowing(id) {
  if (!confirm('Delete this completed borrowing record?')) return;
  try {
    await apiFetch(`/borrowings/${id}`, { method: 'DELETE' });
    showAlert('Borrowing record deleted.');
    loadBorrowings();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

// Delete All Completed Borrowing Records (Admin)
async function deleteAllReturnedBorrowings() {
  if (!confirm('Delete ALL completed (Returned) borrowing records? Active borrowed books will not be affected.')) return;
  try {
    const resData = await apiFetch('/borrowings/returned', { method: 'DELETE' });
    showAlert(resData.message || 'All completed borrowing records deleted.');
    loadBorrowings();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function borrowBook(bookId) {
  try {
    await apiFetch('/borrowings', { method: 'POST', body: JSON.stringify({ book_id: bookId, days: 7 }) });
    showAlert('Book borrowed! Due in 7 days.');
    loadBooks();
    loadBorrowings();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

async function returnBook(borrowingId) {
  try {
    await apiFetch(`/borrowings/${borrowingId}/return`, { method: 'PUT' });
    showAlert('Book returned!');
    loadBooks();
    loadBorrowings();
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

function renderCategoryButtons(booksForList) {
  const bar = document.getElementById('categoryBar');
  const categories = ['All', ...new Set(booksForList.map((b) => b.category).filter(Boolean))];
  if (!categories.includes(selectedCategory)) {
    selectedCategory = 'All';
  }

  bar.innerHTML = '';
  categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cat-btn ${selectedCategory === cat ? 'active' : ''}`;
    btn.textContent = cat;
    btn.onclick = () => {
      selectedCategory = cat;
      loadBooks(document.getElementById('searchInput').value);
    };
    bar.appendChild(btn);
  });
}

async function loadBooks(search = '') {
  try {
    const allList = await apiFetch('/books');
    renderCategoryButtons(allList);

    const params = new URLSearchParams();
    if (selectedCategory && selectedCategory !== 'All') {
      params.set('category', selectedCategory);
    }
    if (search && search.trim() !== '') {
      params.set('search', search.trim());
    }

    const qs = params.toString() ? `?${params.toString()}` : '';
    allBooks = await apiFetch(`/books${qs}`);
    const grid = document.getElementById('booksGrid');
    grid.innerHTML = '';

    if (allBooks.length === 0) {
      grid.innerHTML = '<p class="book-meta">No books match your filter.</p>';
      return;
    }

    allBooks.forEach((book) => {
      const isAdmin = currentUser.role === 'admin';
      const card = document.createElement('div');
      card.className = 'book-card';
      const visualHtml = book.cover_url
        ? `<img src="${book.cover_url}" alt="${book.title}" onerror="this.style.display='none'" />`
        : `<div class="book-icon-box">${BOOK_SVG}</div>`;

      card.innerHTML = `
        <div>
          ${visualHtml}
          <span class="isbn-tag">${book.isbn}</span>
          <h3>${book.title}</h3>
          <p class="book-meta">${book.author} • <b>${book.category}</b></p>
          <p class="stock ${book.avail_copies > 0 ? 'in' : 'out'}">
            Available: ${book.avail_copies} / ${book.total_copies}
          </p>
        </div>
        <div class="card-actions">
          ${!isAdmin ? `<button class="btn btn-primary" ${book.avail_copies < 1 ? 'disabled' : ''} onclick="borrowBook(${book.id})">Borrow</button>` : ''}
          ${isAdmin ? `
            <button class="btn btn-secondary" onclick='startEditBook(${JSON.stringify(book).replace(/'/g, "&#39;")})'>Edit</button>
            <button class="btn btn-danger" onclick="deleteBook(${book.id})">Delete</button>
          ` : ''}
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

document.getElementById('searchInput').oninput = (e) => loadBooks(e.target.value);

async function loadBorrowings() {
  try {
    const rows = await apiFetch('/borrowings');
    const tbody = document.getElementById('borrowingsBody');
    const isAdmin = currentUser.role === 'admin';
    const deleteAllBtn = ensureDeleteAllReturnedButton();

    if (deleteAllBtn) {
      deleteAllBtn.classList.toggle('hidden', !isAdmin);
      const returnedCount = rows.filter((r) => r.status === 'Returned').length;
      deleteAllBtn.disabled = returnedCount === 0;
    }

    tbody.innerHTML = '';

    rows.forEach((row) => {
      let actionHtml = 'Completed';
      if (row.status === 'Borrowed') {
        actionHtml = `<button class="btn btn-secondary" onclick="returnBook(${row.id})">Mark Returned</button>`;
      } else if (isAdmin) {
        actionHtml = `<button class="btn btn-danger" onclick="deleteBorrowing(${row.id})">Delete</button>`;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${row.book_title}</td>
        <td><b>${row.isbn}</b></td>
        ${isAdmin ? `<td>${row.borrower_name}</td>` : ''}
        <td>${new Date(row.borrow_date).toLocaleDateString()}</td>
        <td>${new Date(row.due_date).toLocaleDateString()}</td>
        <td><b>${row.status}</b></td>
        <td>${actionHtml}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showAlert(err.message, 'error');
  }
}

function renderApp() {
  const authSection = document.getElementById('authSection');
  const dashSection = document.getElementById('dashboardSection');
  const userBar = document.getElementById('userBar');

  if (!token || !currentUser) {
    authSection.classList.remove('hidden');
    dashSection.classList.add('hidden');
    userBar.classList.add('hidden');
    return;
  }

  authSection.classList.add('hidden');
  dashSection.classList.remove('hidden');
  userBar.classList.remove('hidden');
  document.getElementById('welcomeText').textContent = `${currentUser.full_name} (${currentUser.role.toUpperCase()})`;

  const isAdmin = currentUser.role === 'admin';
  document.getElementById('adminPanel').classList.toggle('hidden', !isAdmin);
  document.getElementById('thBorrower').classList.toggle('hidden', !isAdmin);
  document.getElementById('borrowingsHeading').textContent = isAdmin ? 'All Student Borrowings' : 'My Borrowed Books';

  loadBooks();
  loadBorrowings();
}

connectWebSocket();
renderApp();