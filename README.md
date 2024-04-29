I'm devepolping this for just some weeks, I'm more focused on getting the underneath scaffolding code working than on having a nice UI
It supports sending and receiving multiple user and display streams with multiple connections to remote peers, but the for the moment initial negotiation for each connection has to be manual. Once connected the negociation happens with datachannels as needed.

In the future a connected peer will function as a relay in establishing new connections when a new peer joins.
In the future chat and file transfers will be added.

Usage:

No much explanation for the moment, everything is going to change, but if want to mess around here you go:

1. open this in a chromium browser https://html-preview.github.io/?url=https://github.com/titi-gal/real-time-free-4-all-communication/blob/main/real-time-free-4-all-communication.html

2. you can show/hide elements by cliking on labels

3. paste a configuration  with STUN servers in the Connection Configuration textarea as in https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection 

4. click on new connection

5. Manually send and receive the descriptions by copyng from and pasting to the Connection Description textarea.
Peer1: copy the offer and send it
Peer2: Paste the received offer, copy the generated answer and send it
Peer1: paste the received answer
Now connection state should be connected

6. each peer should repeat 4 and 5 for each new peer

Inspired by: https://github.com/cjb/serverless-webrtc/