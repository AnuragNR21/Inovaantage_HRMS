# Microsoft 365 Payroll Email Setup

The portal sends generated employee payslips as individual PDF attachments through an idempotent background queue. Each job is bound to one employee, payroll row, and generated document.

## 1. Requirements From IT

Ask IT to provide and confirm:

- A dedicated licensed mailbox, normally `payroll@inovaantage.com`.
- The exact SMTP username and approved From address.
- Authenticated SMTP (`SMTP AUTH`) enabled for that mailbox.
- An approved mailbox or app password for server-side SMTP submission.
- Send As permission when the From address differs from the SMTP account.
- Outbound TCP access from the application host to `smtp.office365.com:587`.
- Whether Conditional Access or tenant policy blocks password-based SMTP.

If the tenant requires OAuth2 and does not permit SMTP passwords, stop here. The current transport uses SMTP username/password authentication and must be extended for the tenant's OAuth2 policy. Do not weaken company security controls.

## 2. Configure `.env`

Update only the local `.env`. Never place credentials in `.env.example`, source code, tickets, or chat.

```ini
EMAIL_NOTIFICATIONS_ENABLED=true
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=payroll@inovaantage.com
SMTP_PASS=the_IT_approved_mailbox_or_app_password
EMAIL_FROM_ADDRESS=payroll@inovaantage.com
EMAIL_FROM_NAME=Inovaantage Payroll
```

For Microsoft 365 on port 587, `SMTP_SECURE=false` is correct. The connection is upgraded with STARTTLS, and `SMTP_REQUIRE_TLS=true` prevents unencrypted delivery.

## 3. Verify Without Sending Email

Run from PowerShell in the project directory:

```powershell
Test-NetConnection smtp.office365.com -Port 587
npm.cmd run verify-email
```

Expected result:

```text
SMTP authentication and TLS verification succeeded. No email was sent.
```

Do not proceed when verification fails. Correct the mailbox, password, SMTP AUTH, Send As, firewall, or tenant-policy issue first.

## 4. Restart the Portal

Environment values are loaded when Node.js starts:

```powershell
npm.cmd start
```

Confirm `http://localhost:3000/health/ready` returns:

```json
{"status":"ready"}
```

## 5. Controlled Delivery Test

1. Give one test employee a valid email address in Employees.
2. Use a finalized payroll row with a generated payslip.
3. Open Payslips and select only that employee.
4. Choose **Email selected** and confirm.
5. Confirm status moves from `PENDING` or `PROCESSING` to `SENT`.
6. Verify the sender, subject, period, recipient, and attached PDF.
7. Confirm the PDF belongs to that employee before testing a larger batch.

## 6. Normal Operation

- Payroll and the employee row must be finalized and not on hold.
- A generated payslip and valid employee email are required.
- Queueing is idempotent; sent or pending jobs are not duplicated.
- The background worker checks jobs every five seconds.
- Transient failures retry with increasing delays, up to five attempts.
- Delivery status is visible on the Payslips page.

## 7. Troubleshooting

| Error | Action |
|---|---|
| Authentication unsuccessful | Verify credentials and mailbox-level SMTP AUTH. |
| Client not authenticated | Check tenant policy and SMTP AUTH. |
| Send As denied | Match From to SMTP user or have IT grant Send As. |
| Connection timeout | Allow outbound TCP 587 and test connectivity. |
| OAuth2 required | Implement the approved OAuth2 transport; do not use an employee password workaround. |
| Employee job fails immediately | Correct the employee's missing or malformed email address. |

## 8. Emergency Disable

Set the following and restart:

```ini
EMAIL_NOTIFICATIONS_ENABLED=false
```

This stops the worker. Queued records remain in Oracle and can resume after the configuration is corrected and delivery is re-enabled.
