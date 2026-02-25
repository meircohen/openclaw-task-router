# Next Batch — Spawn when slots open

## Agent 5: Webhook + Cost Predictor + GitHub Actions
- Webhook receiver (POST /api/webhook/route)
- Cost prediction model (cost-predictor.js — instant estimates from description)
- GitHub Actions integration (PR webhook → route review → post comment)

## Agent 6: Voice + Multi-user + Terminal Dashboard
- Voice-activated routing (integrate with oz-voice spawn_agent — already partially wired)
- Multi-user support: track routing/costs per user ID in ledger, add user filter to dashboard
- Terminal dashboard: `route-task.sh status` shows pretty terminal output with backend health, queue, costs (use chalk or similar for colors)
