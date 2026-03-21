import rateLimit from "express-rate-limit";

export const saveRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many save requests, please retry shortly" }
});

export const gitDiffRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many git diff requests, please retry shortly" }
});

export const gitCommitRateLimiter = rateLimit({
  windowMs: 10_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many git commit requests, please retry shortly" }
});

export const promptRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many prompt requests, please retry shortly" }
});

export const executePlanRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many execute-plan requests, please retry shortly" }
});

export const issueRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many issue requests, please retry shortly" }
});
