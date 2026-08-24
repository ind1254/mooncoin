# App privacy checklist

The bundled privacy manifest declares search history and other diagnostic data
for app functionality because token queries and standard request metadata may
be retained in production hosting/security logs. Both categories are declared
as not linked to the user and not used for tracking. The target contains no
analytics SDK, advertising SDK, persistent identifier, account system, local
preferences, or covered required-reason API usage.

Before submission, confirm the App Store Connect privacy answers against the
production backend and infrastructure configuration. If production retention
or linking differs from this conservative declaration, update both the
manifest and App Store Connect answers before submission.

- [ ] Privacy policy is live at `/privacy`.
- [ ] Support page is live at `/support`.
- [ ] No analytics or tracking SDK was added after this review.
- [ ] No account or owner-key feature was added to the native target.
- [ ] App Store privacy answers match actual Vercel/database logging and retention.
- [ ] Export-compliance answer is reviewed; the target declares no non-exempt encryption.
