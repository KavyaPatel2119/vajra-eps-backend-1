# VAJRA EPS - Backend Development Guide

## Quick Start

### 1. Setup Environment

```bash
cd backend

# Copy .env file
cp .env.example .env

# Install dependencies
npm install
```

### 2. Start Local Services

```bash
# Using Docker Compose (recommended)
docker-compose up -d

# Or start services manually:
# Terminal 1: MongoDB
mongod

# Terminal 2: Redis
redis-server

# Terminal 3: Backend
npm run dev
```

### 3. Database Setup

```bash
# Seed test data
npm run seed

# Reset database
npm run reset-db
```

### 4. Available Endpoints

#### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/refresh` - Refresh JWT token
- `POST /api/v1/auth/logout` - User logout
- `GET /api/v1/auth/me` - Get current user

#### Health Check
- `GET /health` - Server health status

### 5. Testing

```bash
# Run unit tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### 6. Development

```bash
# Start development server (with auto-reload)
npm run dev

# Build for production
npm build

# Lint code
npm run lint
```

## Database Schemas

All 13 MongoDB schemas are created:
- User, Role, Permission
- Exam, Question, Answer, Result
- Device, Session
- UFMReport, SurveillanceLog
- Notification, AuditLog

## Middleware Stack

- ✅ Authentication (JWT)
- ✅ RBAC (Role-based access control)
- ✅ Rate Limiting
- ✅ Error Handling
- ✅ Request Logging
- ✅ Security (MongoDB sanitization, XSS, HPP)

## Key Features (Phase 1)

✅ User registration & login
✅ JWT token generation & refresh
✅ Device tracking
✅ Basic middleware stack
✅ MongoDB connection
✅ Redis connection
✅ Socket.IO setup
✅ Error handling
✅ Logging system

## Next Steps (Phase 2)

- [ ] User management module
- [ ] Exam CRUD endpoints
- [ ] Session management
- [ ] Concurrent login detection
- [ ] UFM automation
- [ ] Surveillance system
- [ ] WebRTC integration
