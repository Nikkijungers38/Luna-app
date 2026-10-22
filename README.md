# Luna · AI Astrology Readings

A web app that gives AI astrology readings in a chat with "Luna."
Visitors get a few free trial minutes, then pay per minute or subscribe.

**Live site:** https://luna-app-m3av.onrender.com (Render free tier — sleeps when idle, first visit can take ~a minute to wake)

## What it does

- Onboarding: name, date of birth, optional birth time/place, and a focus (love, career, money...)
- Computes the visitor's sun sign (with cusp detection), element/modality, and life path number
- Chat readings with Luna (Claude), aware of the current moon phase and able to search the web for what's happening in the sky
- Time is metered while the reading tab is open; balances draw down trial time first, then subscription minutes, then purchased minutes
- Paywall with minute packs (5/10/20/30) and a monthly membership, billed through Stripe

## Running it locally

1. Install Node.js (v18+)
2. `npm install`
3. Copy `.env.example` to `.env` and fill in what you have (everything is optional to start — with no keys it runs in demo/dev mode: sample readings, free test checkouts)
4. `npm start` and open http://localhost:3000

## Configuration

All settings are environment variables — see `.env.example` for the full list.
In production they're set in Render: **Luna-app service → Environment**.

## Notes before taking real customers

- Without `ANTHROPIC_API_KEY`, readings are canned demo text.
- Without `STRIPE_SECRET_KEY`, checkout grants time instantly for free — do not promote the link until Stripe is wired, including the webhook (see `.env.example`).
- User data lives in a local `data/db.json` file. On Render's free tier that file is wiped on redeploys/restarts, and the service sleeps when idle. Fine for testing; move to a real database and a paid instance before launch.
