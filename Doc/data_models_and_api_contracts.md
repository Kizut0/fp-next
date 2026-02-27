# Data Models and API Contracts for "Freelance Link"

## 1. Data Models

### User
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `userId` | ObjectId | Yes | Unique identifier for the user |
| `name` | String | Yes | Full name of the user |
| `email` | String | Yes | Email address (must be unique) |
| `password` | String | Yes | Hashed password |
| `role` | String | Yes | Client, Freelancer, or Admin |
| `status` | String | Yes | Account status (e.g., active, blocked, deactive) |

### Job
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `jobId` | ObjectId | Yes | Unique identifier for the job posting |
| `title` | String | Yes | Title of the job |
| `description` | String | Yes | Detailed project description and requirements |
| `budget` | Number | Yes | Estimated budget for the project |
| `clientId` | ObjectId | Yes | Reference to the User (Client) who posted the job |
| `status` | String | Yes | Job status (open, in_progress, completed, hidden, flagged) |

### Proposal
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `proposalId` | ObjectId | Yes | Unique identifier for the proposal |
| `jobId` | ObjectId | Yes | Reference to the associated Job |
| `freelancerId` | ObjectId | Yes | Reference to the User (Freelancer) submitting the proposal |
| `price` | Number | Yes | Price bidded by the freelancer |
| `message` | String | Yes | Cover letter or additional details provided by the freelancer |
| `status` | String | Yes | Proposal status (submitted, accepted, rejected, withdrawn) |

### Contract
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `contractId` | ObjectId | Yes | Unique identifier for the contract |
| `jobId` | ObjectId | Yes | Reference to the associated Job |
| `clientId` | ObjectId | Yes | Reference to the User (Client) |
| `freelancerId` | ObjectId | Yes | Reference to the User (Freelancer) |
| `startDate` | Date | Yes | Official start date of the contract |
| `endDate` | Date | No | Expected or actual completion date |
| `status` | String | Yes | Contract status (active, completed, cancelled, resolved) |

### Review
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `reviewId` | ObjectId | Yes | Unique identifier for the review |
| `contractId` | ObjectId | Yes | Reference to the Contract being reviewed |
| `rating` | Number | Yes | Star rating or score (e.g., 1-5) |
| `comment` | String | Yes | Written feedback and testimonial |
| `reviewerId` | ObjectId | Yes | Reference to the User submitting the review |

### Payment
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `paymentId` | ObjectId | Yes | Unique identifier for the payment transaction |
| `contractId` | ObjectId | Yes | Reference to the associated Contract |
| `clientId` | ObjectId | Yes | Reference to the User (Client) funding the payment |
| `freelancerId` | ObjectId | Yes | Reference to the User (Freelancer) receiving the payment |
| `amount` | Number | Yes | Transaction amount |
| `paymentDate` | Date | No | Timestamp of when the transaction settled |
| `paymentStatus` | String | Yes | Transaction status (pending, completed, failed, voided) |
| `paymentMethod` | String | Yes | Instrument used (e.g., credit_card, bank_transfer, external_gateway) |

---

## 2. API Contracts

### User API

#### Register Users
- **Route:** `POST /api/auth/register`
- **Request Body:**
```json
{
  "name": "Jane Smith",
  "email": "jane.smith@example.com",
  "password": "securepassword123",
  "role": "Client"
}
```
- **Response Payload:**
```json
{
  "message": "User registered successfully",
  "user": { "userId": "...", "name": "Jane Smith", "email": "jane.smith@example.com", "role": "Client", "status": "active" }
}
```

#### Create Admin Accounts
- **Route:** `POST /api/auth/register-admin`
- **Request Body:**
```json
{
  "name": "System Administrator",
  "email": "admin@freelancelink.com",
  "password": "supersecurepassword",
  "adminToken": "secret-registration-code"
}
```
- **Response Payload:**
```json
{
  "message": "Admin account created successfully",
  "user": { "userId": "...", "role": "Admin", "status": "active" }
}
```

#### View User Lists
- **Route:** `GET /api/admin/users`
- **Response Payload:**
```json
{
  "users": [
    { "userId": "...", "name": "Jane Smith", "email": "jane.smith@example.com", "role": "Client", "status": "active" }
  ]
}
```

#### View Profiles
- **Route:** `GET /api/auth/me`
- **Response Payload:**
```json
{
  "user": { "userId": "...", "name": "Jane Smith", "email": "jane.smith@example.com", "role": "Client", "status": "active" }
}
```

#### Update Profile Info/Status
- **Route:** `PATCH /api/users/:userId`
- **Request Body:**
```json
{
  "name": "Jane S. (Updated)",
  "status": "deactive"
}
```
- **Response Payload:**
```json
{
  "message": "User updated successfully",
  "user": { "userId": "...", "name": "Jane S. (Updated)", "status": "deactive" }
}
```

#### Delete Accounts
- **Route:** `DELETE /api/users/:userId`
- **Response Payload:**
```json
{
  "message": "User account permanently deleted"
}
```

#### Fetch Role-Specific Dashboard Statistics
- **Route:** `GET /api/dashboard`
- **Response Payload:**
```json
{
  "activeJobs": 12,
  "completedContracts": 45,
  "proposalTrends": [
     { "date": "2026-02-27", "count": 5 }
  ]
}
```

---

### Job API

#### Post New Jobs
- **Route:** `POST /api/jobs`
- **Request Body:**
```json
{
  "title": "Full Stack React/Node Developer needed",
  "description": "Looking for a seasoned developer to build a web application dashboard.",
  "budget": 3500
}
```
- **Response Payload:**
```json
{
  "message": "Job successfully created",
  "job": { "jobId": "...", "title": "Full Stack React/Node Developer needed", "status": "open" }
}
```

#### View Job Lists/Details (Filters)
- **Route:** `GET /api/jobs?category=development&minBudget=1000&status=open`
- **Response Payload:**
```json
{
  "jobs": [
    { "jobId": "...", "title": "Full Stack React/Node Developer needed", "budget": 3500 }
  ]
}
```

#### Edit Job Details
- **Route:** `PATCH /api/jobs/:jobId`
- **Request Body:**
```json
{
  "budget": 4000
}
```
- **Response Payload:**
```json
{
  "message": "Job updated",
  "job": { "jobId": "...", "budget": 4000 }
}
```

#### Moderate Status
- **Route:** `PATCH /api/jobs/:jobId/moderate`
- **Request Body:**
```json
{
  "status": "hidden"
}
```
- **Response Payload:**
```json
{
  "message": "Job moderated successfully"
}
```

#### Delete Jobs
- **Route:** `DELETE /api/jobs/:jobId`
- **Response Payload:**
```json
{
  "message": "Job deleted"
}
```

---

### Proposal API

#### Submit Proposals
- **Route:** `POST /api/proposals`
- **Request Body:**
```json
{
  "jobId": "...",
  "price": 3200,
  "message": "I have extensive experience with Next.js and MongoDB."
}
```
- **Response Payload:**
```json
{
  "message": "Proposal submitted successfully",
  "proposal": { "proposalId": "...", "status": "submitted" }
}
```

#### View Proposals based on Role
- **Route:** `GET /api/proposals?jobId=...`
- **Response Payload:**
```json
{
  "proposals": [
    { "proposalId": "...", "freelancerId": "...", "price": 3200, "status": "submitted" }
  ]
}
```

#### Edit Proposals
- **Route:** `PATCH /api/proposals/:proposalId`
- **Request Body:**
```json
{
  "price": 3000
}
```
- **Response Payload:**
```json
{
  "message": "Proposal updated successfully",
  "proposal": { "proposalId": "...", "price": 3000 }
}
```

#### Update Status (shortlist/accept/reject)
- **Route:** `PATCH /api/proposals/:proposalId/accept`
- **Request Body:**
```json
{
  "action": "accept"
}
```
- **Response Payload:**
```json
{
  "message": "Proposal accepted",
  "contract": { "contractId": "...", "status": "active" }
}
```

#### Withdraw Proposals
- **Route:** `DELETE /api/proposals/:proposalId`
- **Response Payload:**
```json
{
  "message": "Proposal withdrawn"
}
```

---

### Contract API

#### Create Contracts from Accepted Proposals
- **Route:** `POST /api/contracts`
- **Request Body:**
```json
{
  "proposalId": "...",
  "startDate": "2026-03-01T00:00:00Z"
}
```
- **Response Payload:**
```json
{
  "message": "Contract established",
  "contract": { "contractId": "...", "status": "active" }
}
```

#### View Contract Details
- **Route:** `GET /api/contracts/:contractId`
- **Response Payload:**
```json
{
  "contract": { "contractId": "...", "jobId": "...", "clientId": "...", "freelancerId": "..." }
}
```

#### Update Status (active/completed/cancelled)
- **Route:** `PATCH /api/contracts/:contractId/completion`
- **Request Body:**
```json
{
  "action": "submit"
}
```
- **Response Payload:**
```json
{
  "message": "Contract completion requested"
}
```

#### Resolve Disputes
- **Route:** `PATCH /api/contracts/:contractId/dispute`
- **Request Body:**
```json
{
  "action": "resolve",
  "decision": "cancelled",
  "resolutionNote": "Dispute resolved via Admin intervention."
}
```
- **Response Payload:**
```json
{
  "message": "Dispute successfully resolved",
  "contract": { "status": "cancelled" }
}
```

---

### Review API

#### Submit Reviews
- **Route:** `POST /api/reviews`
- **Request Body:**
```json
{
  "contractId": "...",
  "rating": 5,
  "comment": "Outstanding work delivered ahead of time."
}
```
- **Response Payload:**
```json
{
  "message": "Review submitted successfully"
}
```

#### View Public Reviews
- **Route:** `GET /api/reviews?userId=...`
- **Response Payload:**
```json
{
  "reviews": [
    { "reviewId": "...", "rating": 5, "comment": "Outstanding work delivered ahead of time." }
  ]
}
```

#### Moderate/Flag Reviews
- **Route:** `PATCH /api/reviews/:reviewId`
- **Request Body:**
```json
{
  "status": "flagged"
}
```
- **Response Payload:**
```json
{
  "message": "Review flagged for moderation"
}
```

#### Delete Abusive Reviews
- **Route:** `DELETE /api/reviews/:reviewId`
- **Response Payload:**
```json
{
  "message": "Review officially deleted"
}
```

---

### Payment API

#### Initiate Payments
- **Route:** `POST /api/payments`
- **Request Body:**
```json
{
  "contractId": "...",
  "amount": 3000,
  "paymentMethod": "stripe"
}
```
- **Response Payload:**
```json
{
  "message": "Payment initiated successfully",
  "payment": { "paymentId": "...", "paymentStatus": "pending" }
}
```

#### View Payment History
- **Route:** `GET /api/payments`
- **Response Payload:**
```json
{
  "payments": [
    { "paymentId": "...", "amount": 3000, "paymentStatus": "pending" }
  ]
}
```

#### Update Payment Status
- **Route:** `PATCH /api/payments/:paymentId`
- **Request Body:**
```json
{
  "paymentStatus": "completed"
}
```
- **Response Payload:**
```json
{
  "message": "Payment status updated",
  "payment": { "paymentId": "...", "paymentStatus": "completed" }
}
```

#### Void Invalid Records
- **Route:** `DELETE /api/payments/:paymentId`
- **Response Payload:**
```json
{
  "message": "Payment effectively voided"
}
```
