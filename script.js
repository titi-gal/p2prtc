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

class StreamsGui extends BaseGui {
    add(stream) {
        if (!this.get(stream)) {
            const videoElement = this.appendElement('video')
            videoElement.id = stream.id
            videoElement.srcObject = stream
            videoElement.controls = true
            videoElement.play()
            return videoElement
        } else {
            return null
        }
    }

    remove(stream) {
        const videoElement = this.get(stream)
        if (videoElement) {
            videoElement.remove()
            return true
        }
        return false
    }

    get(stream) {
        return this.innerContainer.querySelector(`[id="${stream.id}"]`)
    }
}

class LocalPeer {
    constructor(config) {
        this.id = generateUUID()
        this.config = config
        this.newConnections = {}
        this.connections = {}
        this.sendStreams = {}

        this.createGui()
    }

    newConnection(id) {
        // makes a new connection instance
        const connection = new Connection(this.config)
        if (id) {
            connection.id = id
        }
        this.newConnections[connection.id] = connection
        return connection
    }

    connectionFirstConnected(tempraryId, remotePeerId) {
        // once connected, the new connection receives the remote peer id 
        // with the id datachannel that calls this function

        // if remotePeerId is not local peer id and is not a connection of local peer
        if (remotePeerId !== this.id && !this.connections[remotePeerId]) {
            // get connection from new connections
            // change its id
            // remove from new connections and add to connections
            const connection = this.newConnections[tempraryId]
            connection.id = remotePeerId
            connection.updateGuiLabel()
            this.connections[connection.id] = connection
            delete this.newConnections[tempraryId]
            // all all current streams to connection
            Object.values(this.sendStreams).forEach(stream => {
                connection.addStream(stream)
            })
        } else {
            throw new Error('id conflict')
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
        Object.values(this.connections).forEach(connection => {
            connection.addStream(stream)
        })
        this.sendStreams[stream.id] = stream
        this.addSendStreamGui(stream)
    }

    removeStream(stream) {
        Object.values(this.connections).forEach(connection => {
            connection.removeStream(stream)
        })
        stream.getTracks().forEach(track => {
            track.stop()
        })
        delete this.sendStreams[stream.id]
        this.streamsGui.remove(stream)
    }

    addSendStreamGui(stream) {
        // specific gui options for send stream
        const videoElement = this.streamsGui.add(stream)
        videoElement.muted = true
        // enable tracks on play
        videoElement.addEventListener('play', event => {
            const stream = event.target.srcObject
            stream.getTracks().forEach(track => {
                track.enabled = true
            })
        })
        // disable tracks on pause
        videoElement.addEventListener('pause', event => {
            const stream = event.target.srcObject
            stream.getTracks().forEach(track => {
                track.enabled = false
            })
        })
        // remove stream on click
        videoElement.addEventListener('click', (event) => {
            const stream = event.target.srcObject
            this.removeStream(stream)
        })
    }

    createGui() {

        this.gui = new BaseGui({label: `Local Peer Id: ${this.id}`, parent: LOCAL_PEER_PARENT})
        this.streamsGui = new StreamsGui({parent: STREAMS_GUI.innerContainer,label: `Streams Local Peer`})

        const configGui = new BaseGui({parent: this.gui.innerContainer, label: 'Connection Configurarion:'})
        const configTextarea = configGui.appendElement('textarea')
        configTextarea.value = '{}'

        const newConnectionButton = this.gui.appendButton('New Connection')
        const addUserStreamButton = this.gui.appendButton('Add User Stream')
        const addDisplayStreamButton = this.gui.appendButton('Add Display Stream')
        newConnectionButton.addEventListener('click', () => {
            this.config = JSON.parse(configTextarea.value)
            this.newConnection()
        })
        addUserStreamButton.addEventListener('click', () => {
            this.addUserStream()
        })
        addDisplayStreamButton.addEventListener('click', () => {
            this.addDisplayStream()
        })
    }
}

class Connection {
    constructor(config, id) {
        this.config = config
        this.id = id || generateUUID() // remote peer sends its id once connected, this id temporary
        this.reset()
        this.open()
    }

    reset() {
        // rtcpc exists and its not closed
        if (this.rtcpc && this.rtcpc.connectionState !== 'closed') {
            // stop sending all streams
            this.rtcpc.getSenders().forEach(sender => {
                this.rtcpc.removeTrack(sender)
            })
            // closes it
            this.rtcpc.close()

            // removes all receive stream gui
            Object.values(this.receiveStreams).forEach(stream => {
                this.streamsGui.remove(stream)
            })
        }

        // if gui exists kills it
        if (this.gui) {
            this.gui.kill()
            this.streamsGui.kill()
        }

        // set every property to initial state
        this.rtcpc = null // rtcpc means RTCPeerConnection
        this.refuseIfOfferConflict = null // TODO when where to set this?
        this.dataChannels = {}
        this.sendStreams = {}
        this.receiveStreams = {}
        this.gui = null
    }

    open() {
        if (this.rtcpc && this.rtcpc.connectionState !== 'closed') {
            return // connection is already open
        }

        this.rtcpc = new RTCPeerConnection(this.config)
        this.createDataChannels()
        this.dataChannelReceiveListener()
        this.negotiationListener()
        this.streamReceiveListener()
        
        this.createGui()
    }

    // streams

    addStream(stream) {
        // add each track of the stream to the connection, will start sending to remote peer
        if(!this.sendStreams[stream.id]) {
            stream.getTracks().forEach(track => {
                this.rtcpc.addTrack(track, stream)
            })
            this.sendStreams[stream.id] = stream
        }
    }

    removeStream(stream) {
        // removes each track of the stream from the connection, will stop sending to remote peer
        if(this.sendStreams[stream.id]) {
            const senders = this.rtcpc.getSenders()
            stream.getTracks().forEach( track => {
                const sender = senders.find(sender => sender.track === track)
                this.rtcpc.removeTrack(sender)
            })
            delete this.sendStreams[stream.id]
        }
    }

    streamReceiveListener() {
        // receive each track and the stream from remote peer that called addStream()
        this.rtcpc.addEventListener('track', event => {
            if (event.streams.length === 1) {
                const stream = event.streams[0]
                // if stream was not received before
                if (!this.receiveStreams[stream.id]) {
                    // adds it and creates a gui element for it
                    this.receiveStreams[stream.id] = stream
                    this.streamsGui.add(stream)
                    // add event to remove stream when remote peer calls removeStream()
                    stream.addEventListener('removetrack', event => {
                        // remove stream and its gui element
                        delete this.receiveStreams[event.target.id]
                        this.streamsGui.remove(event.target)
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
        await this.rtcpc.setLocalDescription()
        return this.sendAndReturnLocalDescription()
    }

    async receiveOfferOrAnswer(description) {
        if (// receives an offer and signalingState is have-local-offer in an offer conflict
            description.type === 'offer' &&
            this.rtcpc.signalingState === 'have-local-offer' &&
            // one peer should aways refuse
            // other peer should aways accept
            this.refuseIfOfferConflict) {
                // refusing peer does nothing and wait for an answer
                return  null
        
        // both peers (or accepting peer on offer conflict) processes an offer and sends an answer
        } else if (description.type === 'offer') {
            await this.rtcpc.setRemoteDescription(description)
            await this.rtcpc.setLocalDescription()
            return this.sendAndReturnLocalDescription()

        // both peers accepts answers in any case
        } else if (description.type === 'answer') {
            await this.rtcpc.setRemoteDescription(description)
        }
    }

    async sendAndReturnLocalDescription() {
        // send description to remote peer, (will receive if datachannel is open)
        this.sendMessage('sdp', this.rtcpc.localDescription)

        // return description on ice complete
        // if ice is already complete returns local description
        if (this.rtcpc.iceGatheringState === 'complete') {
            return this.rtcpc.localDescription
        
        // else create a new promise to wait ice complete before returning
        } else {
            return await new Promise((resolve) => {
                // add this event listener to rtcpc to check ice state
                // the event removes itself once is done
                const onIceGatheringStateChange = () => {
                    if (this.rtcpc.iceGatheringState === 'complete') {
                        this.rtcpc.removeEventListener('icegatheringstatechange', onIceGatheringStateChange)
                        resolve(this.rtcpc.localDescription)
                    }
                }
                this.rtcpc.addEventListener('icegatheringstatechange', onIceGatheringStateChange)
            })
        }
    }

    negotiationListener() {
        this.rtcpc.addEventListener('icecandidate', event => {
            // TODO create a specific icecandidate datachannel and call connection.addIceCandidate() when onMessage
        })
        this.rtcpc.addEventListener('icecandidateerror', event => {
            // TOMAYBEDO
            console.log(`icecandidateerror: ${event.toString()}`)
        })

        this.rtcpc.addEventListener('negotiationneeded', event => {
            // create a new local description to start negotiation
            this.sendOffer()
        })
    }

    // datachannels functions

    createDataChannels() {
        this.createDataChannel({
            label: 'sdp',
            onMessage: sdpChannelOnMessage
        })

        this.createDataChannel({
            label: 'id',
            onMessage: idChannelOnMessage,
            onOpen: idChannelOnOpen
        })

        this.createDataChannel({
            label: 'newconnection',
            onMessage: newConnectionChannelOnMessage
        })
    }
    
    createDataChannel({label, onMessage=()=>{}, onOpen=()=>{}, onClose=()=>{}}) {
        const receiveOrRelayMessage = (event) => {
            const message = JSON.parse(event.data)
            // messages has a destination peer and destination is not local peer 
            if (message.to && message.to !== LOCAL_PEER.id) {
                // if local peer has a connection to destination peer, relay to him using the same channel label
                const toConnection = LOCAL_PEER.connections[message.to]
                if (toConnection) {
                    toConnection.sendMessage(event.target.label, message)
                }
                // ignore if local peer doesn't have a connection to destination peer

            // receive message that doesn't have a destination peer or destination is local peer
            } else {
                onMessage(event, this)
            }
        }
        const dataChannel = {
            sendChannel: this.rtcpc.createDataChannel(label),
            receiveChannel: null,
            onMessage: (event) => { receiveOrRelayMessage(event, this) },
            onOpen: (event) => { onOpen(event, this) },
            onClose: (event) => { onClose(event, this) },
        }
        this.dataChannels[label] = dataChannel
    }

    sendMessage(label, message, to) {
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

    dataChannelReceiveListener() {
        this.rtcpc.addEventListener('datachannel', event => {

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

    updateGuiLabel() {
        if (this.gui) {
            this.gui.label.innerText = `Connection Remote Peer Id: ${this.id}`
            this.streamsGui.label.innerText = `Streams Remote Peer Id: ${this.id}`
        }
    }

    createGui() {
        this.gui = new BaseGui({parent: CONNECTIONS_PARENT})
        this.streamsGui = new StreamsGui({parent: STREAMS_GUI.innerContainer})
        this.updateGuiLabel()

        const negotiationGui = async () => {
            // negotiation elements
            const negotiationGui = new BaseGui({parent: this.gui.innerContainer})
            const negotiationTextarea = negotiationGui.appendElement('textarea')
            const newOfferButon = negotiationGui.appendButton('New Offer')
            negotiationTextarea.readOnly = true
            negotiationGui.label.innerText = 'Connection Description: '

            let localDescription
            // create and show a new offer
            newOfferButon.addEventListener('click', async () => {
                localDescription = await this.sendOffer()
                negotiationTextarea.value = JSON.stringify(localDescription)
            })

            // deal with pasted offers or answers
            negotiationTextarea.addEventListener('paste', async (event) => {

                // get description
                let pastedDescription
                try {
                    pastedDescription = new RTCSessionDescription(JSON.parse(event.clipboardData.getData('text')))
                } catch (error) {
                    negotiationTextarea.value = `error parsing JSON: ${error.toString()}`
                    return
                }

                // receive description and get response description
                try {
                    localDescription = await this.receiveOfferOrAnswer(pastedDescription)
                } catch (error) {
                    negotiationTextarea.value = `error receiving description: ${error.toString()}`
                    return
                }

                // show respose description
                negotiationTextarea.value = JSON.stringify(localDescription)
            })

            negotiationTextarea.addEventListener('click', () => {
                negotiationTextarea.select()
            })
        }

        const statesGui = () => {
            const statesGui = new BaseGui({parent: this.gui.innerContainer})
            const statesTextarea = statesGui.appendElement('textarea')
            statesGui.label.innerText = 'Connection States:'

            const updateStates = () => {
                statesTextarea.value =
                `Connection: ${this.rtcpc.connectionState}\n` +
                `Signaling: ${this.rtcpc.signalingState}\n` +
                `Ice Gathering: ${this.rtcpc.iceGatheringState}\n` +
                `Ice Connection: ${this.rtcpc.iceConnectionState}`
            }
            
            updateStates()
            this.rtcpc.addEventListener('connectionstatechange', updateStates)
            this.rtcpc.addEventListener('iceconnectionstatechange', updateStates)
            this.rtcpc.addEventListener('icegatheringstatechange', updateStates)
            this.rtcpc.addEventListener('signalingstatechange', updateStates)


        }

        const statsGui = () => {
            const statsGui = new BaseGui({parent: this.gui.innerContainer})
            const statsTextarea = statsGui.appendElement('textarea')
            statsGui.label.innerText = 'Connection Stats:'
            statsGui.innerContainer.hidden = true

            let startStatsintervalId

            const updateStats = () => {
                this.rtcpc.getStats().then((stats) => {
                    let statsOutput
                    stats.forEach((report) => {
                        // show these report values on top
                        statsOutput +=
                        `Report: ${report.type}\nID: ${report.id}\n` +
                        `Timestamp: ${report.timestamp}\n`
                
                        // other report values, ignoring the ones sorted on top
                        Object.keys(report).forEach((statName) => {
                        if (statName !== 'id' &&
                            statName !== 'timestamp' &&
                            statName !== 'type') {
                            statsOutput += `${statName}: ${report[statName]}\n`
                        }
                        })
                        // end of report
                        statsOutput += '\n'
                    })
                    // end of stats
                    statsTextarea.value = statsOutput
                })
            }

            const startStats= () => {
                updateStats()
                startStatsintervalId = setInterval(() => {updateStats()}, 1000)
            }

            const stopStats = () => {
                clearInterval(startStatsintervalId)
            }

            statsGui.label.addEventListener('click', (event) => {
                if (statsGui.innerContainer.hidden) {
                    stopStats()
                } else {
                    startStats()
                }
            })
        }

        negotiationGui()
        statesGui()
        statsGui()
    }
}

function idChannelOnOpen(event, connection) {
    connection.sendMessage('id', {
        id: LOCAL_PEER.id,
        connections: Object.keys(LOCAL_PEER.connections)
    })
}

function idChannelOnMessage(event, connection) {
    const IdAndConnections = JSON.parse(event.data).message
    // add peer to connected list
    LOCAL_PEER.connectionFirstConnected(connection.id, IdAndConnections.id)

    // filter all peers that local peer does not know and remote peer knows
    const newConnections = IdAndConnections.connections.filter(id => id !== LOCAL_PEER.id && !LOCAL_PEER.connections[id])

    // ask remote peer to negotiate a connection with each not known peer
    newConnections.forEach(async (remotePeerId) => {
        // create or retrieve a new connection
        let newConnection = LOCAL_PEER.newConnections[remotePeerId]
        if (!newConnection) {
            newConnection = LOCAL_PEER.newConnection(remotePeerId)
        }
        const offer = await newConnection.sendOffer()
        connection.sendMessage('newconnection', offer, remotePeerId)
    })
}

async function sdpChannelOnMessage(event, connection) {
    const description = new RTCSessionDescription(JSON.parse(event.data).message)
    connection.receiveOfferOrAnswer(description)
}

async function newConnectionChannelOnMessage(event, connection) {
    const message = JSON.parse(event.data)

    // create or retrieve a new connection
    let newConnection = LOCAL_PEER.newConnections[message.from]
    if (!newConnection) {
        newConnection = LOCAL_PEER.newConnection(message.from)
    }

    // process offer or answer with the connection
    const answer = await newConnection.receiveOfferOrAnswer(message.message)

    // send back a answer if exists
    if (answer) {
        connection.sendMessage('newconnection', answer, message.from)
    }
}

const MAIN_GUI = new BaseGui()
const LOCAL_PEER_PARENT = MAIN_GUI.appendElement('div')
const STREAMS_GUI = new BaseGui({parent: MAIN_GUI.innerContainer, label: 'Streams'})
const CONNECTIONS_PARENT = MAIN_GUI.appendElement('div')

const LOCAL_PEER = new LocalPeer()

function generateUUID() {
    const crypto = window.crypto
    if (crypto) {
      return crypto.randomUUID()
    } else {
      throw new Error('Crypto API not available')
    }
}