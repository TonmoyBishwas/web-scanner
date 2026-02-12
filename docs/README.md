# Web Scanner Documentation

This directory contains detailed documentation for the Web Scanner component of the Review Goods system.

## Contents

- [**Architecture**](./ARCHITECTURE.md): High-level overview of the Next.js app, Redis integration, and component structure.
- [**API Reference**](./API_REFERENCE.md): Detailed documentation of the internal API routes (`/api/scan`, `/api/ocr`, etc.).

## Quick Start for Developers

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Variables**:
    Required in `.env.local`:
    - `REDIS_URL` & `REDIS_TOKEN`: Upstash Redis connection.
    - `TELEGRAM_BOT_WEBHOOK_URL`: URL of the Python bot (e.g., `https://bot-production.up.railway.app`).
    - `CLOUDINARY_*`: Credentials for image upload.

3.  **Run Development Server**:
    ```bash
    npm run dev
    ```

4.  **Simulate a Session**:
    Since sessions are created by the Bot, you can manually create a key in Redis or use the Bot to generate a link like `http://localhost:3000/scan/YOUR-UUID-TOKEN`.
