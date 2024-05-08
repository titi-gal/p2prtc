# p2p-rtc

Right now I'm more focused on getting the underneath scaffolding code working than on having a nice UI.

## Features
- Send and receive multiple user and display streams with multiple p2p connections.
- Initial connection is manual, once connected negotiation happens with data channels.
- A new connected peer uses the connection as a relay to connect to the others peers.
- In the future, chat and file transfers will be added.

## Instructions
Not much explanation for the moment, as everything is changing, but if you want to mess around, here you go:

1. Open in a Chromium browser (I only tested in the Brave browser): https://html-preview.github.io/?url=https://github.com/titi-gal/p2p-rtc/blob/main/p2p-rtc-single.html 
    WARNING! Something in the way GitHub html-preview loads the JavaScript broke the code when testing, and I'm not feeling like debugging this right now. Download and open the file offline if you have any trouble.

2. Paste a configuration with STUN and/or TURN servers in the Configuration textarea as in https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection:

    configuration example:

    ```json
    {
        "iceServers": [
            {
                "urls": [
                    "stun:stun.example.com:port"
                ]
            },
            {
                "urls": [
                    "turn:turn.example.com:port"
                ],
                "username": "username",
                "credential": "password"
            }
        ]
    }
    ```

3. Manually send and receive the descriptions using the Description textarea.
    Peer1: Get offer, copy it, and send to Peer2.
    Peer2: Paste the received offer, copy the generated answer, and send it to Peer1.
    Peer1: Paste the received answer.

    Now, the peers should be connected. Repeat to add new peers; existing peers will be automatically connected when a new peer is added.


Inspired by: https://github.com/cjb/serverless-webrtc/