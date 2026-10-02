export interface CallbackViewParams {
  provider?: string;
  title: string;
  status: 'success' | 'warning' | 'info' | 'error';
  reference?: string;
  orderId?: string;
  amountFormatted?: string;
  message: string;
  details?: Record<string, string | number | undefined>;
}

export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderCallbackStatusHtml(params: CallbackViewParams): string {
  const isSuccess = params.status === 'success';
  const isWarning = params.status === 'warning' || params.status === 'error';
  const providerLabel = params.provider ? escapeHtml(params.provider.toUpperCase()) : 'COMMERCE';

  const iconSvg = isSuccess
    ? `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>`
    : isWarning
    ? `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>`
    : `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>`;

  const badgeClass = isSuccess ? 'status-badge-success' : isWarning ? 'status-badge-warning' : 'status-badge-info';
  const badgeText = isSuccess ? 'PAID / CONFIRMED' : isWarning ? 'FAILED / DECLINED' : 'PENDING';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(params.title)} - Ductape Commerce</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --success: #10b981;
      --success-bg: rgba(16, 185, 129, 0.12);
      --warning: #f59e0b;
      --warning-bg: rgba(245, 158, 11, 0.12);
      --info: #3b82f6;
      --info-bg: rgba(59, 130, 246, 0.12);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    body {
      background: radial-gradient(circle at 50% 0%, #1e293b 0%, #0f172a 100%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      max-width: 500px;
      width: 100%;
      padding: 2.5rem 2rem;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45);
    }
    .icon-container {
      width: 76px;
      height: 76px;
      border-radius: 50%;
      margin: 0 auto 1.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      background: ${isSuccess ? 'var(--success-bg)' : isWarning ? 'var(--warning-bg)' : 'var(--info-bg)'};
      border: 2px solid ${isSuccess ? 'var(--success)' : isWarning ? 'var(--warning)' : 'var(--info)'};
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--text);
    }
    p.message {
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 1.75rem;
    }
    .details-box {
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 2rem;
      text-align: left;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.55rem 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 0.88rem;
    }
    .detail-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .detail-row:first-child {
      padding-top: 0;
    }
    .detail-label {
      color: var(--text-muted);
    }
    .detail-value {
      font-weight: 600;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      word-break: break-all;
      text-align: right;
      padding-left: 0.75rem;
    }
    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.65rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .status-badge-success {
      background: rgba(16, 185, 129, 0.2);
      color: var(--success);
      border: 1px solid var(--success);
    }
    .status-badge-warning {
      background: rgba(245, 158, 11, 0.2);
      color: var(--warning);
      border: 1px solid var(--warning);
    }
    .status-badge-info {
      background: rgba(59, 130, 246, 0.2);
      color: var(--info);
      border: 1px solid var(--info);
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 0.85rem 1rem;
      border-radius: 10px;
      font-weight: 600;
      font-size: 0.95rem;
      text-align: center;
      text-decoration: none;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
      border: none;
    }
    .btn-primary {
      background: #2563eb;
      color: white;
    }
    .btn-primary:hover {
      background: #1d4ed8;
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      border: 1px solid var(--card-border);
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }
    .footer-note {
      margin-top: 1.5rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      letter-spacing: 0.04em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-container">
      ${iconSvg}
    </div>
    <h1>${escapeHtml(params.title)}</h1>
    <p class="message">${escapeHtml(params.message)}</p>

    <div class="details-box">
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <span class="status-badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Gateway</span>
        <span class="detail-value">${providerLabel}</span>
      </div>
      ${
        params.reference
          ? `<div class="detail-row">
        <span class="detail-label">Reference</span>
        <span class="detail-value">${escapeHtml(params.reference)}</span>
      </div>`
          : ''
      }
      ${
        params.orderId
          ? `<div class="detail-row">
        <span class="detail-label">Order ID</span>
        <span class="detail-value">${escapeHtml(params.orderId)}</span>
      </div>`
          : ''
      }
      ${
        params.amountFormatted
          ? `<div class="detail-row">
        <span class="detail-label">Amount</span>
        <span class="detail-value">${escapeHtml(params.amountFormatted)}</span>
      </div>`
          : ''
      }
    </div>

    <div class="actions">
      <button id="done-btn" class="btn btn-primary" type="button">Close Window</button>
      <div id="close-msg" style="display: none; margin-top: 1rem; padding: 0.85rem 1rem; border-radius: 10px; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #10b981; font-size: 0.9rem; line-height: 1.4;">
        ✓ Order confirmed and stock secured! You can safely close this browser tab.
      </div>
    </div>

    <div class="footer-note">
      Ductape Multi-Provider Commerce Engine
    </div>
  </div>

  <script>
    (function() {
      var btn = document.getElementById('done-btn');
      var msg = document.getElementById('close-msg');
      if (btn) {
        btn.addEventListener('click', function() {
          try {
            window.close();
          } catch (e) {}

          btn.textContent = '✓ Order Confirmed';
          btn.style.background = '#10b981';
          btn.style.cursor = 'default';
          if (msg) {
            msg.style.display = 'block';
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}
