# Ludo Rooms (self-hosted)

Multiplayer Ludo you run yourself. Share a 6-letter room code, play with 2-10 friends. Up to 4 play on the classic cross board; 5 to 10 play on a round board sized to the group. The host picks 2, 3, or 4 tokens per player in the lobby. Includes live in-game chat, 12 funny stickers that pop up over the board, emoji avatars, animated piece movement, sound effects with a mute button, and a win celebration. It is also an installable web app: open the link on a phone, choose Add to Home Screen, and it runs full screen with its own icon like a normal app. No ads. The server rolls the dice and checks every move, so nobody can cheat.

Works on UGREEN DXP models (UGOS Pro has Docker built in). The small DH models (DH2300 / DH4300) do not support Docker.

## Deploy on a UGREEN NAS

1. In UGOS File Manager, create a folder, for example: docker/ludo-rooms
2. Upload everything in this zip into that folder (keep the public subfolder).
3. Note the folder's full path (it usually starts with /volume1/...).
4. Open the Docker app, go to Project, then Create.
5. Name it ludo-rooms and paste the contents of docker-compose.yml.
6. Change the volume line so the left side is your real folder path from step 3.
7. Deploy. First start takes a minute (it downloads two small packages).
8. Open http://YOUR-NAS-IP:8090 on any phone or computer on your Wi-Fi.

To use a different port, change "8090" in docker-compose.yml.

## Playing from outside your home

Out of the box this works for everyone on your home Wi-Fi. For friends elsewhere you need one of:

- Tailscale (easiest and safe: you and your friends install it, then they use the same NAS address)
- Cloudflare Tunnel (gives you a normal https link anyone can open, no router changes)
- Router port forwarding (works, but exposes the port to the whole internet - least recommended)

## Notes

- Rooms live in the server's memory. If the container restarts, open rooms are lost.
- A turn is auto-skipped after 60 seconds (45 seconds at tables of 6 or more) so one absent player cannot freeze the game.
- Rooms hold up to 10 players. For big groups, 2 or 3 tokens per player keeps games a sensible length.
- Empty or idle rooms are cleaned up automatically after 2 hours.


## Graphics V5
- **Dark mode**: theme toggle (auto / light / dark) with system preference support; board palette, filters, and lighting adapt.
- **Advanced SVG filters**: multi-octave grain, specular lighting (feSpecularLighting + point light), theme-aware shadows, pawn specular filter.
- WebGL renderer removed after review: it replaced the detailed board with flat discs on most devices and lacked context-loss recovery. The SVG renderer (with performance fixes) is the single path.
- Carries forward V4 pawn, hub, and cell polish. Gameplay/server rules are unchanged.
