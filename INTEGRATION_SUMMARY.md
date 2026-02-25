# OpenClaw Task Router - Rate Governor and Timeout Fallback Integration

## Summary of Changes

### ✅ TASK 1: Fixed Claude Code Timeout Fallback

**Problem:** When Claude Code or Codex tasks timed out, the process was killed but the error didn't propagate cleanly to trigger the router's fallback chain.

**Solution:** Enhanced timeout error handling in both `claude-code.js` and `codex.js`:

- Timeout errors now include specific error codes (`CLAUDE_CODE_TIMEOUT`, `CODEX_TIMEOUT`)
- Added `shouldFallback: true` flag to timeout errors
- Enhanced router's `executeWithBackend` method to detect timeout errors and trigger fallback
- Improved error classification to distinguish timeouts from rate limits

**Files Modified:**
- `claude-code.js` - Enhanced timeout error creation with fallback properties
- `codex.js` - Enhanced timeout error creation with fallback properties  
- `index.js` - Improved error handling and fallback logic in `executeWithBackend`

### ✅ TASK 2: Wired Rate Governor into Router

**Problem:** Rate governor existed but wasn't fully integrated into the backend selection and execution flow.

**Solution:** Comprehensive rate governor integration:

- Rate governor already existed and was imported - enhanced the integration
- Added rate limit checks during backend selection in `selectBackend` method
- Added real-time rate checks just before execution in `executeWithBackend` method
- Implemented soft limit delays (5-second delays when approaching limits)
- Added hard limit fallback suggestions
- Enhanced success and failure recording for rate tracking
- Proper initialization in router's `initialize` method

**Key Features:**
- **Soft limits**: At 80% of backend limit, adds 5-second delays
- **Hard limits**: When limit reached, suggests fallback backend
- **Cooldown periods**: 15-minute cooldowns after throttling events
- **Adaptive learning**: Reduces limits to 80% after throttle events
- **Persistent state**: Maintains request history across restarts

### ✅ TASK 3: Enhanced Circuit Breaker Rate Governor Integration

**Problem:** Circuit breaker needed better detection of rate limit failures to coordinate with rate governor.

**Solution:** Enhanced rate limit detection in `circuit-breaker.js`:

- Expanded rate limit error detection patterns:
  - "rate limit", "throttle", "quota", "429"
  - "usage limit", "too many requests"
- Enhanced `recordFailure` method to detect rate limit errors
- Automatic rate governor throttle recording when rate limits detected
- Added contextual information (timestamp, error details) to throttle events
- Lazy loading to avoid circular dependencies

## Integration Architecture

```
Request → Router → Rate Governor Check → Backend Selection → Circuit Breaker Check → Execution
                     ↓                      ↓                     ↓
                 Soft Delay           Rate Fallback        Failure Recording
                     ↓                      ↓                     ↓
                Rate Tracking         Health Tracking      Throttle Learning
```

## Fallback Chain Flow

```
claudeCode (timeout/rate limit) → codex (timeout/rate limit) → api → local
```

**Enhanced Error Handling:**
- Timeouts now properly trigger fallback chain
- Rate limits suggest optimal fallback backend
- Circuit breaker coordinates with rate governor
- All failure types properly recorded for learning

## Testing Results

The integration test confirms:

✅ Rate governor properly tracks requests and applies limits
✅ Circuit breaker detects rate limit errors and records them  
✅ Timeout errors have proper fallback properties
✅ Fallback chain correctly routes between backends
✅ Soft delays work for backends approaching limits
✅ Hard limits properly block and suggest fallbacks

## Backend State Management

Each backend now maintains:
- **Request history** (60-minute sliding window)
- **Current limits** (adaptive based on throttle events)
- **Throttle events** (learning from rate limit patterns)
- **Cooldown states** (15-minute recovery periods)
- **Circuit breaker state** (CLOSED/OPEN/HALF-OPEN)

## Files Modified

1. **`index.js`**: Enhanced backend selection, execution, and fallback logic
2. **`claude-code.js`**: Improved timeout error handling
3. **`codex.js`**: Improved timeout error handling  
4. **`circuit-breaker.js`**: Enhanced rate limit detection
5. **`test-integration.js`**: Comprehensive test suite (new)
6. **`INTEGRATION_SUMMARY.md`**: This summary (new)

## Usage

The router now automatically:
- Applies rate limiting before backend execution
- Handles soft limits with delays
- Routes around hard-limited backends
- Records all interactions for adaptive learning
- Triggers fallback chain on timeouts and rate limits
- Coordinates between circuit breaker and rate governor

No API changes required - existing router usage continues to work with enhanced reliability and fallback handling.