# SPEC — Dialog Wallet : retrait pUSD vers MetaMask

## 1. Objectif

Ajouter un dialog **Wallet** dans le dashboard qui permet de retirer un montant
choisi du collatéral du bot (deposit wallet Polymarket V2) vers une adresse
MetaMask, via le même mécanisme relayer que le redeem — sans jamais manipuler
la clé privée depuis le frontend.

```
┌─────────────────────────── Dialog Wallet ───────────────────────────┐
│  Deposit wallet: 0xAbC…f01        Mode: LIVE                        │
│                                                                     │
│  Solde on-chain pUSD :  1 234.56   (source de vérité du retrait)    │
│  Disponible CLOB     :  1 230.00   (− réserves des ordres reposés)  │
│  Valeur positions    :     12.34                                    │
│                                                                     │
│  Montant à retirer : [   100.00   ] [MAX]        (USDC, 6 déc. max) │
│  Destination       : [ 0x… MetaMask ]   (mémorisée en localStorage) │
│                                                                     │
│  ⚠ Si montant > dispo CLOB : ordres reposés peuvent être touchés    │
│                                                                     │
│  [ Annuler ]                        [ Retirer → confirmation ]      │
│                                                                     │
│  ── Historique ──────────────────────────────────────────────────   │
│  17/09 14:02   500.00  → 0x9f3…c21   ✓ mined   0xabc… (Polygonscan) │
└─────────────────────────────────────────────────────────────────────┘
```

## 2. Mécanique (découverte validée dans le repo)

- Le bot trade via un **deposit wallet Polymarket V2** (`POLY_1271`,
  `signatureType = 3`, adresse = `FUNDER_ADDRESS`), un smart-contract wallet
  déployé par `DepositWalletFactory`. L'EOA signataire (`PRIVATE_KEY`) en est
  le owner.
- Le collatéral V2 est **pUSD** (« Polymarket USD », ERC-20 Polygon,
  `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`, 6 décimales) — vérifié
  on-chain (`name()`/`symbol()`/`decimals()`).
- Le repo exécute déjà des batches on-chain **gasless** sur ce wallet via le
  relayer Polymarket : `redeemViaRelayer` (`src/relayer.ts`) construit des
  `DepositWalletCall { target, value, data }` et appelle
  `RelayClient.executeDepositWalletBatch(calls, walletAddress, deadline)`.
- **Un retrait = exactement le même flow avec un seul appel** :
  `ERC-20.transfer(to, amount)` sur pUSD
  (selector `0xa9059cbb`, montant en 6 décimales).
  - Auth relayer : `RELAYER_API_KEY` (préféré) sinon HMAC Builder — déjà géré
    par `createRelayClient`.
  - Le relayer est async : réponse immédiate (transactionID) puis polling via
    `response.wait()` → txHash une fois miné (1-3 min typiques).
  - Pas de gaz à prévoir : le relayer dispatch gasless.

**Note métier importante** : le retrait envoie du **pUSD**, pas de l'USDC
natif. MetaMask affiche le token une fois ajouté (contract ci-dessus).
La conversion pUSD→USDC se fait via l'interface Polymarket — **hors scope**
de cette spec (extension future : batch 2 appels via le redeemer pUSD→USDC).

## 3. Contrat API

Toutes les routes sont hébergées par `DashboardServer` (127.0.0.1), protégées
par `isAllowedOrigin` (même garde que `/api/redeem`). Le backend détient
`PRIVATE_KEY` ; le frontend n'envoie que `{ amountUsd, to }`.

### GET `/api/wallet/withdraw/quote`
Retourne l'état du wallet pour affichage + garde pré-submit.

```jsonc
{
  "funder": "0xAbC…",              // null si FUNDER_ADDRESS absent
  "onChainPusd": 1234.567891,      // balanceOf(funder) sur pUSD, en USD ; null si RPC KO
  "clobAvailable": 1230.0,         // getAvailableCollateral() ; null si pas de client CLOB
  "ready": true,                   // funder != null && onChainPusd != null
  "reason": "FUNDER_ADDRESS non configuré" // si !ready
}
```

### POST `/api/wallet/withdraw`
Body : `{ "amountUsd": 500, "to": "0x…" }`

- 400 : body invalide, `to` non adresse EVM valide, `to` == funder, `to`
  == address nulle, `amountUsd` <= 0, `amountUsd` > 0 et > onChainPusd,
  plus de 6 décimales.
- 503 : relayer indisponible (pas de PRIVATE_KEY, pas de creds relayer,
  handler non initialisé).
- 200 : `{ ok: true, txHash, transactionId }` (après mining, timeout
  requête déjà à 300 s comme `/api/redeem`).
- 500 : échec relayer (message d'erreur brut relayé, quota 429 inclus).

Chaque tentative est journalisée en base (succès ET échec).

### GET `/api/wallet/withdrawals?limit=20`
`{ "withdrawals": [{ ts, to, amount, txHash, success, errorMessage }] }`
triés DESC par ts.

### Événement SSE
Nouveau type bus `{ type: "withdrawal"; status: "pending"|"success"|"failed";
to: string; amount: number; txHash?: string; message?: string }` émis au
départ, au succès et à l'échec (non persisté dans `events` — la table
`withdrawals` fait foi).

## 4. Base de données

Table `withdrawals` (miroir de `redeems`) :

```sql
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  "to" TEXT NOT NULL,
  amount REAL NOT NULL,
  txHash TEXT,
  source TEXT NOT NULL,          -- "manual"
  success INTEGER NOT NULL,
  errorMessage TEXT
);
```

- `WithdrawalRepository` : `insert`, `recent(limit)`, `prune(beforeTs)`
  (copie conforme du pattern `RedeemRepository`).
- Ajoutée à `Database.reset()`.
- Aucune clé runtime-settings (pas de champ éditable) → pas de touche sur
  `runtime-settings.ts`.

## 5. UI (frontend SolidJS)

- **Bouton "Wallet"** dans le `Header` (à côté de QuotaBadge / capital),
  ouvre `WalletModal`.
- `WalletModal` (nouveau fichier `components/modals/WalletModal.tsx`,
  réutilise `.modal` / `.modal-overlay` existants) :
  - Au chargement : GET quote → soldes + funder + état ready.
  - Champs : montant (input numérique, `MAX` = onChainPusd), destination
    (adresse hex ; pré-remplie depuis `localStorage["wallet.withdraw.to"]`,
    sauvegardée à l'envoi).
  - Validation live : adresse `0x[0-9a-fA-F]{40}`, montant > 0, ≤ onChainPusd,
    ≤ 6 décimales. Bouton désactivé sinon.
  - **Étape confirmation obligatoire** (reprend le pattern `ConfirmModal`
    inline) : récap « Retirer X pUSD vers 0x… — irréversible ».
  - Pending : spinner + « Transaction relayer en cours (1-3 min) »,
    bouton désactivé.
  - Succès : txHash + lien Polygonscan ; Échec : message + l'historique
    reste consultable.
  - Historique : GET withdrawals (20 derniers), badges ✓/✗ + lien Polygonscan.
- `api/client.ts` : `walletWithdrawQuote()`, `walletWithdraw(body)`,
  `walletWithdrawals(limit)`.
- `types/index.ts` : `WalletQuote`, `WithdrawalRow`, `WithdrawResponse`.
- Le mode readonly (`readonlyLive`) n'interdit PAS le retrait : c'est une
  action manuelle explicite, authentifiée par l'origin check — le badge
  READONLY reste visible dans le header.

## 6. Backend — nouveaux fichiers / modifications

| Fichier | Changement |
|---|---|
| `src/withdraw.ts` (nouveau) | `buildTransferCalldata(to, amountUsd)` (pur), `validateWithdrawRequest(...)` (pur), `getOnChainPusdBalance(config)` (viem `balanceOf`, public client publicnode), `withdrawViaRelayer(config, { to, amountUsd })` (export `createRelayClient` depuis `relayer.ts`, même deadline 4 h, quota `recordQuotaExceeded/Ok`, polling `wait()`) |
| `src/relayer.ts` | `createRelayClient` passe de privé à exporté (aucun changement de comportement) |
| `src/db/database.ts` | table `withdrawals` + `reset()` |
| `src/db/repositories.ts` + `src/db/index.ts` | `WithdrawalRepository` |
| `src/dashboard/events.ts` | union `BotEvent` + type `withdrawal` |
| `src/dashboard/server.ts` | 3 routes + handlers (pattern `handleRedeem`) + insertion DB success/échec |

Le trader (ClobClient) n'est PAS modifié : le solde on-chain passe par viem
directement, comme `isCtfApproved` dans relayer.ts.

## 7. Garde-fous

1. **Jamais de clé privée côté frontend** — le POST ne transporte que
   montant + adresse ; la signature est faite par l'EOA du backend.
2. Origin check identique aux autres routes mutatives.
3. Validation stricte du destinataire (adresse checksummable via viem
   `isAddress` ; rejet funder/zero-address — anti auto-transfert).
4. **Montant borné au solde on-chain** (source de vérité du transfert).
   Avertissement (non bloquant) si `amount > clobAvailable` : les ordres
   reposés peuvent perdre leur backing.
5. Idempotence logique : pas de double-submit (bouton désactivé pendant le
   pending) ; chaque POST crée une ligne DB unique.
6. Le relayer peut rejeter (quota, deadline, signature) : l'erreur est
   renvoyée telle quelle au dialog, l'échec est persisté.

## 8. Tests

`tests/withdraw.test.ts` (node --test, ajouté au script `test`) :

- `buildTransferCalldata` : calldata = `0xa9059cbb` + address paddée +
  montant 6-décimales paddé (cas 500 → `0x1DCD65000`, cas 0.000001).
- `floorUsdToSixDecimals` : 1234.5678915 → 1234.567891 (floor, jamais round-up).
- `validateWithdrawRequest` : rejects — montant <= 0, adresse invalide,
  `to` == funder, `to` == 0x0…0, 7 décimales, montant > solde.
- Quote/handler : cas funder manquant → 503 avec raison (test handler-level
  avec un DashboardServer de stub si coûteux ; sinon validation pure couverte).

## 9. Plan d'implémentation (ordre)

1. `src/withdraw.ts` (pures + viem balance + relayer flow) + `tests/withdraw.test.ts`.
2. `src/relayer.ts` : export `createRelayClient`.
3. DB : table + repo + reset + export `Repositories`.
4. `events.ts` type `withdrawal`.
5. `server.ts` : routes GET quote / POST withdraw / GET history.
6. Frontend : types → `api/client.ts` → `WalletModal.tsx` → bouton `Header`
   → câblage `App.tsx` → CSS (extensions minimales).
7. `package.json` : ajouter `tests/withdraw.test.ts` au script `test`.
8. Vérification : `npm run test` (complet) + `npm run build` +
   `npm --prefix frontend run build`.

## 10. Hors scope (follow-ups possibles)

- Conversion pUSD→USDC après retrait (batch 2-appels redeemer).
- Retrait programmé / automatique (ex. au-dessus d'un seuil).
- Multi-destination (carnet d'adresses).