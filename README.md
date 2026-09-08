# Blackjack · Private Table

A casino-style blackjack site you play with friends. Fully static: one browser hosts the table and the others join with a five-letter room code (peer-to-peer via PeerJS, no game server). Solo play works even offline.

## Rules

- 6-deck shoe, real Fisher–Yates shuffle from `crypto.getRandomValues`, cut card at roughly 75% penetration, one burn card. The shoe is only reshuffled when the cut card comes out.
- Blackjack pays 3 to 2. Dealer stands on all 17s (soft 17 included). Dealer peeks for blackjack on an Ace or a ten-value up card.
- Insurance offered when the dealer shows an Ace; pays 2 to 1.
- Double on any first two cards. Split up to four hands; split aces get one card each.
- **Dealer Bust** side bet: pays 2 to 1 if the dealer busts with exactly three cards, 3 to 1 with four or more. Can be played on its own without a main bet.
- **Bet behind** any other seat: your chips follow that player's main hand, including their doubles and splits when you can cover them.
- Everyone chooses their own buy-in in the lobby with − / + (or by typing). Buy-ins lock when the host opens the table.
- The counter at the top shows how far you are up or down, green or red. Every seat shows the same for its player.
- Lose everything and you can stay to watch or leave. Anyone can leave at any time.

## Run

Open `index.html` (or serve the folder) and click **Open a table**. Share the code shown in the lobby; friends enter it under **Join friends**. Up to 7 seats, unlimited spectators.

## Test

```
node --test tests/
```
