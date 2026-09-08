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
- Betting works like a real table: pick a chip from the rack, then tap your **BET** circle, the **DEALER BUST** spot, or a friend's circle to bet behind them. **Undo**, **Clear**, **Repeat** (same bets as last hand), **2×** and **All in** sit next to the rack. Enter deals, Backspace undoes, R repeats.
- The bankroll panel top-left shows your chips and how far you are up or down this session, green or red. Every seat shows the same for its player.
- Cards are dealt one at a time out of the shoe in casino order; the hole card flips before the dealer draws.
- Lose everything and you can stay to watch or leave. Anyone can leave at any time.

## Run

Open `index.html` (or serve the folder) and click **Open a table**. Share the code shown in the lobby; friends enter it under **Join friends**. Up to 7 seats, unlimited spectators.

## Test

```
node --test tests/
```
