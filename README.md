# p2prtc

Right now I'm more focused on getting the underneath scaffolding code working than on having a nice UI.

## Features
- Send and receive multiple user and display streams with multiple p2p connections.
- Initial connection is manual, once connected negotiation happens with data channels.
- A new connected peer uses the connection as a relay to connect to the others peers.
- In the future, chat and file transfers will be added.

## Instructions
Not much explanation for the moment, as everything is changing, but if you want to mess around, here you go:

1. Download and open the file (Only tested in chromium based browsers).

2. Paste a configuration with STUN and TURN servers in the configuration textarea as in https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection.

    Configuration example:

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

3. Manually send and receive the descriptions using the description textarea.
    Peer1: Get offer, copy it, and send to Peer2.
    Peer2: Paste the received offer, copy the generated answer, and send it to Peer1.
    Peer1: Paste the received answer.

    The peers should be connected. Repeat to add new peers. Existing peers will be automatically connected when a new peer is added.


Inspired by: https://github.com/cjb/serverless-webrtc/