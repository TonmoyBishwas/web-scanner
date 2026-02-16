#!/bin/bash
# Quick rollback script to main branch

echo "🔄 Rolling back to main branch..."

# Switch to main
git checkout main

# Deploy main to production
vercel --prod --yes

echo "✅ Rollback complete! Main branch is now in production."
