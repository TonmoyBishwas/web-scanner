# Web Scanner Setup Guide

## Step 1: Deploy to Vercel

```bash
cd /Users/tonmoybishwas/Downloads/Tonmoy/0_n8n/web-scanner
```

### Option A: Vercel CLI (Recommended)

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

### Option B: GitHub Integration

1. Push code to GitHub
2. Go to https://vercel.com/new
3. Import the repository
4. Vercel will detect Next.js automatically

## Step 2: Configure Environment Variables in Vercel

Go to your Vercel project → Settings → Environment Variables and add:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SCANDIT_LICENSE_KEY` | Your Scandit license key |
| `NEXT_PUBLIC_APP_URL` | Your Vercel URL (e.g., `https://web-scanner-abc.vercel.app`) |
| `TELEGRAM_BOT_WEBHOOK_URL` | Your bot's webhook URL (e.g., Railway URL) |
| `KV_REST_API_URL` | Upstash REST API URL |
| `KV_REST_API_TOKEN` | Upstash REST API Token |

**Important**: Redeploy after adding environment variables!

## Step 3: Note Your Scanner URL

After deployment, your scanner URL will be:
```
https://your-app.vercel.app/scan/{token}
```

Save this for the bot configuration.
