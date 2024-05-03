class LocalPeer {
    constructor(connectionConfig) {
        this.id = generateUUID()
        this.connectionConfig = connectionConfig
        this.remotePeers = {}
        this.sendStreams = {}
    }

    addRemotePeer(id) {
        const remotePeer = new RemotePeer(this.connectionConfig, id)
        this.remotePeers[remotePeer.id] = remotePeer
        remotePeer.connection.addEventListener("connectionstatechange", (event) => {
            if (remotePeer.connection.connectionState === 'failed' ||
            remotePeer.connection.connectionState === 'disconnected' ||
            remotePeer.connection.connectionState === 'closed') {
                this.removeRemotePeer(remotePeer.id)
            }
        })
        return remotePeer
    }

    removeRemotePeer(id) {
        const remotePeer = this.remotePeers[id]
        remotePeer.setConnection()
        delete this.remotePeers[id]
    }

    getRemotePeer(id) {
        return this.remotePeers[id]
    }

    async getOffer() {
        const remotePeer = this.addRemotePeer()
        const offer = await remotePeer.sendOffer()
        return {
            id: remotePeer.id,
            description: offer
        }
    }

    async receiveOfferOrAnswer(descriptionWithId) {
        let remotePeer = this.getRemotePeer(descriptionWithId.id)
        if (!remotePeer) {
            remotePeer = this.addRemotePeer()
        }
        const answer = await remotePeer.receiveOfferOrAnswer(descriptionWithId.description)
        return {
            id: descriptionWithId.id,
            description: answer
        }
    }

    async addUserStream() {
        try {
            // get streams from, webcams, mics, etc
            const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true})
            // add stream to all connections and stores it
            this.addStream(stream)
        } catch (error) {
            console.log(`failed to get user media: ${error.toString()}`)
        }
    }

    async addDisplayStream() {
        // get streams from screen, window, tab
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({audio: true, video: true})
            // add stream to all connections and stores it
            this.addStream(stream)
        } catch (error) {
            console.log(`failed to get display media: ${error.toString()}`)
        }
    }

    addStream(stream) {
        Object.values(this.remotePeers).forEach(remotePeer => {
            remotePeer.addStream(stream)
        })
        this.sendStreams[stream.id] = stream
    }

    removeStream(stream) {
        Object.values(this.remotePeers).forEach(remotePeer => {
            remotePeer.removeStream(stream)
        })
        stream.getTracks().forEach(track => {
            track.stop()
        })
        delete this.sendStreams[stream.id]
    }
}

class RemotePeer {
    constructor(connectionConfig, id) {
        this.id = id || generateUUID()
        this.connectionConfig = connectionConfig
        this.setConnection()
        this.openConnection()
    }

    setConnection() {
        // connection exists and its not closed
        if (this.connection && this.connection.connectionState !== 'closed') {
            // stop sending all streams
            this.connection.getSenders().forEach(sender => {
                this.connection.removeTrack(sender)
            })
            // closes it
            this.connection.close()
        }

        // set every property to initial state
        this.connection = null
        this.refuseIfOfferConflict = null // TODO make peers fight over this once connected
        this.dataChannels = {}
        this.sendStreams = {}
        this.receiveStreams = {}
    }

    openConnection() {
        if (this.connection) {
            if (this.connection.connectionState === 'closed') {
                this.setConnection() // make sure all properties are in initual value
            } else {
                return // connection is already open
            }
        }

        this.connection = new RTCPeerConnection(this.config)

        // this.connection listeners, separated just for organization
        this.streamListener()
        this.dataChannelListener()
        this.negotiationListener()

        // there is a specific dataChannel object encapsulating the one given by webRTC
        this.createDataChannels()
    }

    // streams

    addStream(stream) {
        // add each track of the stream to the connection, will start sending to remote peer
        if(!this.sendStreams[stream.id]) {
            stream.getTracks().forEach(track => {
                this.connection.addTrack(track, stream)
            })
            this.sendStreams[stream.id] = stream
        }
    }

    removeStream(stream) {
        // removes each track of the stream from the connection, will stop sending to remote peer
        if(this.sendStreams[stream.id]) {
            const senders = this.connection.getSenders()
            stream.getTracks().forEach( track => {
                const sender = senders.find(sender => sender.track === track)
                this.connection.removeTrack(sender)
            })
            delete this.sendStreams[stream.id]
        }
    }

    streamListener() {
        // receive each track and the stream from remote peer that called addStream()
        this.connection.addEventListener('track', event => {
            if (event.streams.length === 1) {
                const stream = event.streams[0]
                // if stream was not received before
                if (!this.receiveStreams[stream.id]) {
                    // adds it
                    this.receiveStreams[stream.id] = stream
                    // add event to remove stream when remote peer calls removeStream()
                    stream.addEventListener('removetrack', event => {
                        // removes it
                        delete this.receiveStreams[event.target.id]
                    })
                }
            } else {
                // the way addStrem is coded this event should aways receive a stream
                throw new Error(`event.streams.length is ${event.streams.length}, expected 1`)
            }
        })
    }

    // negotitation functions

    async sendOffer() {
        await this.connection.setLocalDescription()
        return this.sendAndReturnLocalDescription()
    }

    async receiveOfferOrAnswer(description) {
        if (// receives an offer and signalingState is have-local-offer is an offer conflict
            description.type === 'offer' &&
            this.connection.signalingState === 'have-local-offer' &&
            // one peer should aways refuse
            // other peer should aways accept
            this.refuseIfOfferConflict) {
                // refusing peer does nothing and wait for an answer
                return  null
        
        // both peers (or accepting peer on offer conflict) processes an offer and sends an answer
        } else if (description.type === 'offer') {
            await this.connection.setRemoteDescription(description)
            await this.connection.setLocalDescription()
            return await this.sendAndReturnLocalDescription()

        // both peers accepts answers in any case
        } else if (description.type === 'answer') {
            await this.connection.setRemoteDescription(description)
            // there is no further negotiation
            return  null
        }
    }

    async sendAndReturnLocalDescription() {
        // send description to remote peer, (will receive if datachannel is open)
        this.sendMessage('sdp', this.connection.localDescription)

        // return description on ice complete
        // if ice is already complete returns local description
        if (this.connection.iceGatheringState === 'complete') {
            return this.connection.localDescription
        
        // else create a new promise to wait ice complete before returning
        } else {
            return await new Promise((resolve) => {
                // add this event listener to connection to check ice state
                // the event removes itself once is done
                const onIceGatheringStateChange = () => {
                    if (this.connection.iceGatheringState === 'complete') {
                        this.connection.removeEventListener('icegatheringstatechange', onIceGatheringStateChange)
                        resolve(this.connection.localDescription)
                    }
                }
                this.connection.addEventListener('icegatheringstatechange', onIceGatheringStateChange)
            })
        }
    }

    negotiationListener() {
        this.connection.addEventListener('icecandidate', event => {
            // TODO create a specific icecandidate datachannel and call connection.addIceCandidate() when onMessage
        })
        this.connection.addEventListener('icecandidateerror', event => {
            // TOMAYBEDO
            console.log(`icecandidateerror: ${event.toString()}`)
        })
        this.connection.addEventListener('negotiationneeded', event => {
            // data channel creation triggers this event when connection is new, which is not needed
            if (this.connection.connectionState !== 'new') {
                // create a new local description to start negotiation if connection is not new
                this.sendOffer()
            }
        })
    }

    // datachannels functions

    createDataChannels() {
        this.createDataChannel({
            label: 'sdp',
            onMessage: sdpChannelOnMessage
        })
    }
    
    createDataChannel({label, onMessage=()=>{}, onOpen=()=>{}, onClose=()=>{}}) {

        // all received messages are relayed (if needed) before OnMessage is called
        const receiveOrRelayMessage = (event) => {
            const message = JSON.parse(event.data)
            // messages has a destination peer and destination is not local peer 
            if (message.to !== LOCAL_PEER.id) {
                // if local peer has a connection to destination peer, relay to him using the same channel label
                const toConnection = LOCAL_PEER.connections[message.to]
                if (toConnection) {
                    toConnection.sendMessage(event.target.label, message)
                }
                // ignored if local peer doesn't have a connection to destination peer

            // receive message that doesn't have a destination peer or destination is local peer
            } else {
                onMessage(event, this)
            }
        }

        const dataChannel = {
            sendChannel: this.connection.createDataChannel(label),
            receiveChannel: null,
            onMessage: (event) => { receiveOrRelayMessage(event, this) },
            onOpen: (event) => { onOpen(event, this) },
            onClose: (event) => { onClose(event, this) },
        }
        this.dataChannels[label] = dataChannel
    }

    sendMessage(label, message, to=this.id) {
        // triggers remote peer datachannel message event
        if (!message.from) {
            // create message metadata of it does not exist
            message = {
                from: LOCAL_PEER.id,
                to: to,
                message: message
            }
        }
        const dataChannel = this.dataChannels[label]
        if (dataChannel && dataChannel.sendChannel.readyState  === 'open') {
            dataChannel.sendChannel.send(JSON.stringify(message))
        }
    }

    dataChannelListener() {
        this.connection.addEventListener('datachannel', event => {

            // adds received data channel to the corresponding datachannel object
            const dataChannel = this.dataChannels[event.channel.label]
            dataChannel.receiveChannel = event.channel

            // when receiving events
            // if dataChannel has a callback for the event, calls it

            dataChannel.receiveChannel.addEventListener('message', event => {
                if (dataChannel.onMessage) {
                    dataChannel.onMessage(event)
                }
            })
    
            dataChannel.receiveChannel.addEventListener('open', event => {
                if (dataChannel.onOpen) {
                    dataChannel.onOpen(event)
                }
            })

            dataChannel.receiveChannel.addEventListener('close', event => {
                if (dataChannel.onClose) {
                    dataChannel.onClose(event)
                }
            })
        })
    }
}

async function sdpChannelOnMessage(event, connection) {
    const description = new RTCSessionDescription(JSON.parse(event.data).message)
    connection.receiveOfferOrAnswer(description)
}

class BaseGui {
    /*
    <anyelement> //parent, where the instance should be appended
        <div> //outerContainer
            <label></label> //label, on click toggle innerContainer
            <div> //innerContainer, where elements of the instance are appended
            </div>
        </div>
    </anyelement>
    */
    constructor({label='', parent=document.querySelector('body')} = {}) {
        this.parent = parent
        this.OuterContainer = document.createElement('div')
        this.innerContainer = document.createElement('div')
        this.label = document.createElement('label')
        this.label.innerText = label
        this.OuterContainer.append(this.label)
        this.OuterContainer.append(this.innerContainer)
        this.parent.append(this.OuterContainer)

        this.label.addEventListener('click', () => {
            this.innerContainer.toggleAttribute('hidden')
        })
    }

    kill() {
        this.OuterContainer.remove()
    }

    appendElement(name) {
        const element = document.createElement(name)
        this.innerContainer.append(element)
        return element
    }

    appendButton(text) {
        const button = this.appendElement('button')
        button.innerText = text
        return button
    }
}

function generateUUID() {
    const crypto = window.crypto
    if (crypto) {
      return crypto.randomUUID()
    } else {
      throw new Error('Crypto API not available')
    }
}

const LOCAL_PEER = new LocalPeer()

const manualDescription = new BaseGui({label: 'Description:'})
const descriptionTextarea = manualDescription.appendElement('textarea')
const GetOfferButton = manualDescription.appendButton('Get Offer')

GetOfferButton.addEventListener('click', async () => {
    const description = await LOCAL_PEER.getOffer()
    descriptionTextarea.value = JSON.stringify(description)
})

descriptionTextarea.addEventListener('paste', async (event) => {

    // get description
    let pastedDescription
    try {
        pastedDescription = JSON.parse(event.clipboardData.getData('text'))
    } catch (error) {
        event.target.value = `error parsing JSON: ${error.toString()}`
        return
    }

    // receive description and get response description
    try {
        localDescription = await LOCAL_PEER.receiveOfferOrAnswer(pastedDescription)
    } catch (error) {
        event.target.value = `error receiving description: ${error.toString()}`
        return
    }

    // show respose description
    event.target.value = JSON.stringify(localDescription)
})
