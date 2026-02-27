# Freelance Link Backend (`fp-next`)

Backend implementation for the project:
**"Freelance Link: A Web-Based Freelancer Hiring Platform for Clients and Freelancers"**

This repository provides the API layer for:
- Authentication
- Jobs
- Proposals
- Contracts
- Milestones and completion flow
- Payments, ledger, disputes, and webhook reconciliation
- Reviews
- Admin moderation and dashboard stats

## Tech Stack
- Next.js API Routes (App Router)
- Node.js
- MongoDB Atlas
- JWT authentication
- bcrypt password hashing

## Backend Scope
- Role-based access control (`Client`, `Freelancer`, `Admin`)
- Job lifecycle support (`draft`, `open`, `in_progress`, `completed`, `cancelled`)
- Proposal submission, accept/reject, withdraw
- Contract creation and lifecycle management
- Milestone-based completion, review, and release
- Payment state machine:
  - `reserved -> in_review -> released -> withdrawn`
  - plus `failed`, `refunded`, `disputed`
- Dispute evidence + mediation flow
- Escrow ledger entries for payment transitions
- Admin monitoring endpoints (users/stats/payments/contracts)

## Project Structure
```txt
src/
  app/api/                  # API route handlers
    auth/
    jobs/
    proposals/
    contracts/
    payments/
    reviews/
    admin/
    dashboard/
    health/
  lib/                      # shared backend logic
    api.js                  # auth checks, JSON helpers, ObjectId helpers
    auth.js                 # JWT + password hashing
    mongodb.js              # DB connection handling
    indexes.js              # strong unique index setup
    contractMilestones.js   # milestone logic + SLA helpers
    payments.js             # payment state machine + ledger/dispute logic
```

## Environment Variables
Create `.env.local` (or `.env`) in `fp-next`:

```env
PORT=5000
MONGODB_URI=<your_mongodb_connection_string>
MONGODB_DB=web_project_2

USER_COLLECTION=userData
JOB_COLLECTION=Job
PAYMENT_COLLECTION=Payment
PROPOSAL_COLLECTION=Proposal
REVIEW_COLLECTION=Review
CONTRACT_COLLECTION=Contract

JWT_SECRET=<strong_secret>
ADMIN_SIGNUP_CODE=<admin_bootstrap_code>
CORS_ORIGIN=http://127.0.0.1:5173,http://localhost:5173
```

Notes:
- `MONGODB_DB` defaults to `web_project_2`.
- Admin self-registration is blocked in normal register flow.
- Keep `.env` and `.env.local` out of public repositories.

## Run Locally
```bash
cd fp-next
pnpm install
pnpm dev
```

API URL:
- `http://127.0.0.1:3000/api`

## Scripts
```bash
pnpm dev      # start dev server
pnpm build    # production build
pnpm start    # run production server
pnpm lint     # run ESLint
```

## API Route Groups
- Auth
  - `/api/auth/login`
  - `/api/auth/register`
  - `/api/auth/me`
- Jobs
  - `/api/jobs`
  - `/api/jobs/[id]`
- Proposals
  - `/api/proposals`
  - `/api/proposals/[id]`
  - `/api/proposals/[id]/accept`
  - `/api/proposals/[id]/reject`
- Contracts
  - `/api/contracts`
  - `/api/contracts/[id]`
  - `/api/contracts/[id]/complete`
  - `/api/contracts/[id]/completion`
  - `/api/contracts/[id]/change-orders`
  - `/api/contracts/[id]/dispute`
  - `/api/contracts/[id]/escalations`
- Payments
  - `/api/payments`
  - `/api/payments/ledger`
  - `/api/payments/webhook`
- Reviews
  - `/api/reviews`
  - `/api/reviews/[id]`
- Admin + Monitoring
  - `/api/admin/users`
  - `/api/admin/users/[id]`
  - `/api/admin/stats`
  - `/api/dashboard`
  - `/api/health/db`

## Data Integrity
The backend enforces key unique indexes:
- `users.email` unique
- active proposal uniqueness by `(jobId, freelancerId)`
- one review per `(contractId, reviewerId, revieweeId)`
- unique contract by `proposalId`

## Docker
Build image:
```bash
docker build -t backend:1.0 .
```

Run container:
```bash
docker run -d --name backend-server -p 3000:3000 --env-file .env backend:1.0
```

## Team Members
- Aung Myat Oo Gyaw (6726066)  
  Github: [Kizut0](https://github.com/Kizut0)
- Mi Hsu Myat Win Myint (6726115)  
  Github: [hsumyatwin-myint](https://github.com/hsumyatwin-myint)
- Su Eain Dray Myint (6726094)  
  Github: [u6726094-dot](https://github.com/u6726094-dot)
