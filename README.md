# Memact Extension

The Memact browser extension is an optional capture source.

It records useful browser activity locally, applies privacy boundaries, and makes
approved evidence available to the Memact capture pipeline. Apps can still use
Memact through SDK/API integration without installing the extension.

## Owns

- Browser/page activity capture.
- Local evidence collection.
- Privacy boundary checks before graph or packet creation.
- Extension-side storage, search, and export helpers.
- Browser bridge APIs for approved local snapshots.

## Does Not Own

- App API key verification.
- User consent management.
- Hosted memory storage.
- Studio feature execution.
- Final personalization features.

## Development

```powershell
npm install
npm run check
npm run build
```

`npm run build` creates `artifacts/memact-extension.zip`.

## License

BUSL-1.1. See [LICENSE](LICENSE).
