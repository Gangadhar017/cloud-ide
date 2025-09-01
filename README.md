# Cloud IDE — (Monaco frontend + Docker executor)

## Prerequisites
- Docker installed and working (ability to `docker run hello-world`).
- Node 18+ & npm (if building container locally).
- (Optional) Docker Compose to run the app via compose.

## Quick start (local host)
1. Clone/copy the project.
2. Install dependencies:
   npm install
3. Start server:
   node server.js
4. Open http://localhost:3000

## Quick start (Docker Compose)
1. Build & start:
   docker-compose up --build
2. Visit http://localhost:3000

> NOTE: docker-compose mounts /var/run/docker.sock into the app container so the app can spawn containers to execute user code. This is powerful and dangerous — run only in trusted environments.

## Run samples
- Create a workspace (UI button), edit a file, then Save → Run.
- Try Python, Java, and C++ templates.

## Production considerations
- Add authentication & session management.
- Replace direct docker socket access with a separate executor service (recommended).
- Use gVisor or Kata runtime for stronger isolation. See earlier notes about adding `--runtime=runsc`.
