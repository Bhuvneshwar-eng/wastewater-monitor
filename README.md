# Smart Wastewater Monitor

## Run (no npm install needed, Node 18+)
    node server.js          # http://localhost:3000, simulator ON
    SIMULATE=0 node server.js   # when a real ESP32 is posting

## Features
- Live pH / turbidity / temperature graphs with green / amber / red / blue (too low) alerts
- **History**: every reading -> `data/readings.csv`; alerts + pump actions -> `data/events.csv`.
  Dashboard "Download CSV" gives the last 24 h for reports; "Show 24 h summary" shows min/avg/max, % time out of range, alert and dose counts.
- **Dosing pumps**: Auto / Manual / Off. Auto runs a short pulse (5 s) of base (pH low), acid (pH high) or coagulant (turbidity high),
  then waits 60 s so the water mixes and the sensors can re-measure. Max 20 pulses/hour per chemical, then lockout + notification.
- **Notifications** on danger (once per parameter per 5 min) and on pump lockout.

## Telegram alerts (no extra packages)
1. In Telegram, message @BotFather -> /newbot -> copy the token.
2. Send any message to your bot, then open https://api.telegram.org/bot<TOKEN>/getUpdates and copy `chat.id`.
3. Start the server:
       TELEGRAM_TOKEN=123:abc TELEGRAM_CHAT_ID=987654 node server.js

## Email alerts
    npm install nodemailer
    ALERT_EMAIL_TO=you@example.com SMTP_HOST=smtp.gmail.com SMTP_PORT=587 \
    SMTP_USER=you@gmail.com SMTP_PASS=<app password> node server.js
(Gmail needs an app password, not your normal password.)

## Wiring the pumps (ESP32)
GPIO25 = base relay, GPIO26 = acid relay, GPIO27 = coagulant relay (change in the .ino).
- Use a relay module and a separate pump supply; add a flyback diode across DC pumps.
- Safety built in: pumps are OFF at boot, OFF if WiFi/server/sensor fails, and capped at 10 s per command on the ESP32 itself.
- Test with water first, never with chemicals, until you've confirmed the logic does what you expect.

## Sensors / calibration
pH on GPIO34, turbidity on GPIO35, DS18B20 on GPIO4. Calibrate pH with 4.00/7.00 buffers; calibrate turbidity against standards.

## ESP32 -> server format
POST /api/data  {"ph":7.21,"turbidity":34.5,"temperature":24.8}
Reply: {"ok":true,"pumps":{"base":0,"acid":0,"coag":1}}

## Live demo (simulation only, no hardware)
`node server.js` starts the simulator by default and pre-fills 1 hour of history, so every feature works immediately.
1. Open http://localhost:3000. Graphs update every 2 s.
2. Press **Acid spill** in the demo panel. pH falls, the card turns blue (too low), the banner changes, the base pump lights up in Auto mode, and pH climbs back.
3. Press **Hot discharge**. Temperature goes red and a notification appears (there is no cooling pump, so it stays red until the incident ends: a good point to discuss).
4. Switch the pumps to **Manual** and dose by hand, or **Off** and watch an incident go uncorrected.
5. Open **Reports** for the summary and CSV download.
6. Notifications appear on the dashboard as simulated Telegram/email messages. Add real credentials (above) and the same events are also sent for real.
Demo timing: pulses are 4 s with a 12 s wait (5 s / 60 s on real hardware). Incidents last 45 s.
