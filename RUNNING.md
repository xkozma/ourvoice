# OurVoice - Local Run Guide

This is a demo full-stack hobby project with:
- **Backend**: Express API with mock laws and local JSON persistence
- **Frontend**: React app for viewing laws, citizen voting, usefulness voting, and comments

## 1) Install dependencies
From project root:

```bash
npm install
npm run install:all
```

## 2) Start frontend + backend together

```bash
npm run dev
```

This starts:
- Backend on `http://localhost:4000`
- Frontend on `http://localhost:5173`

## 3) Optional: start services separately

In terminal 1:

```bash
npm run dev:backend
```

In terminal 2:

```bash
npm run dev:frontend
```

## 4) Configure frontend/backend URLs (local or deployment)

Use environment files so frontend and backend can be connected without code changes.

- `frontend/.env`

```bash
VITE_API_URL=http://localhost:4000/api
```

- `backend/.env`

```bash
PORT=4000
JWT_SECRET=change-this-in-production
CORS_ORIGIN=http://localhost:5173
```

`CORS_ORIGIN` can be a comma-separated list in deployment, for example:

```bash
CORS_ORIGIN=https://your-frontend.app,https://staging-frontend.app
```

For deployment, set `VITE_API_URL` to your deployed backend URL, for example:

```bash
VITE_API_URL=https://api.your-domain.com/api
```

## 5) Try the app
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

## Render deployment (single web service)

Yes, you can use `npm run dev` as the Render start command with this repo setup.

Render service settings:

- **Build Command**

```bash
npm install && npm run render:build
```

- **Start Command**

```bash
npm run dev
```

Required environment variables on Render:

- `JWT_SECRET` = strong random secret

Optional environment variables:

- `CORS_ORIGIN` (only needed if frontend is hosted on a different domain)
- `PORT` is provided by Render automatically

Important behavior:

- On Render, `npm run dev` automatically starts backend only.
- Backend serves `frontend/dist` and API from the same domain.
- Frontend uses same-origin `/api` by default in production.
