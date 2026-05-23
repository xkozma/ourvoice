# OurVoice - Local Run Guide

This is a demo full-stack hobby project with:
- **Backend**: Express API with mock laws and local JSON persistence
- **Frontend**: React app for viewing laws, citizen voting, usefulness voting, and comments

## 1) Install dependencies
From project root:

```bash
npm run install:all
```

## 2) Start backend
In terminal 1:

```bash
npm run dev:backend
```

Backend runs on `http://localhost:4000`.

## 3) Start frontend
In terminal 2:

```bash
npm run dev:frontend
```

Frontend runs on `http://localhost:5173`.

## 4) Try the app
1. Open `http://localhost:5173`
2. Register a user account (name + email + password)
3. Browse laws and compare:
   - **Government side**: official vote result and status
   - **Citizen side**: support/oppose + useful/useless totals
4. As signed-in user, click:
   - `Support` or `Oppose`
   - `Useful` or `Useless`
   - Add comments under each law

## Notes
- Mock laws are stored in `backend/data/laws.json`
- User accounts and votes/comments are stored in `backend/data/db.json`
- This is a demo setup (no production DB, no advanced security hardening)
