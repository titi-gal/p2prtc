class BaseGui {
    /*
    //parent, where the instance should be appended
    <div> //outerContainer
        <label></label> //label, on click toggle innerContainer
        <div> //innerContainer, where elements of the instance are appended
        </div>
    </div>
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
        this.connections = {}
        this.sendStreams = {}

        this.createGui()
    }

    newConnection() {
        if (this.connectingConnection) {
            this.connectingConnection.reset()
        }
        this.connectingConnection = new Connection(this.config)
    }

    addConnection(connectionInstance) {
        // once connected, the connection data channel receives its id from remote peer and calls this

        // TODO maybe this should bo receive a connectionInstance and intead should use the connectingConnection aways?
        
        // if connection id in not peer id and not other connectios ids
        if (connectionInstance.remotePeerId !== this.id && !this.connections[connectionInstance.remotePeerId]) {
            // free the connecting connection reference
            this.connectingConnection = null
            // store this connection in connections
            this.connections[connectionInstance.remotePeerId] = connectionInstance
            // all all current streams to connection
            Object.values(this.sendStreams).forEach(stream => {
                connectionInstance.addStream(stream)
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
    constructor(config) {
        this.config = config
        this.remotePeerId = null // remote peer sends its id once connected
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
        this.refuseOnOfferConflict = null //TODO when where to set this?
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

        this.negotiationListener()
        this.streamReceiveListener()
        this.dataChannelReceiveListener()

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

    async setLocalOfferAndSend() {
        await this.rtcpc.setLocalDescription()
        this.sendMessage('sdp', this.rtcpc.localDescription)
        return await this.getDescriptionOnIceComplete()
    }

    async setRemoteOfferSetLocalAnswerAndSend(description) {
        if(description.type === 'offer') {
            await this.rtcpc.setRemoteDescription(description)
            await this.rtcpc.setLocalDescription()
            this.sendMessage('sdp', this.rtcpc.localDescription)
            return await this.getDescriptionOnIceComplete()
        } else {
            throw new Error(`description.type is ${description.type}, expected offer`)
        }
    }

    async setRemoteAnswer(description) {
        if(description.type === 'answer') {
            await this.rtcpc.setRemoteDescription(description)
        } else {
            throw new Error(`description.type is ${description.type}, expected answer`)
        }
    }

    async receiveDescription(description) {
        if (// if have local offer and
            this.rtcpc.signalingState === 'have-local-offer' &&
            // received offer and
            description.type === 'offer' &&
            // should refuse on offer conflict
            this.refuseOnOfferConflict) {
                // do nothing, answer will come from remote peer
                return  null
        } else if (description.type === 'offer') {
            return await this.setRemoteOfferSetLocalAnswerAndSend(description)
        } else if (description.type === 'answer') {
            await this.setRemoteAnswer(description)
        }
    }

    async getDescriptionOnIceComplete() {
        // if ice is complete returns local description
        if (this.rtcpc.iceGatheringState === 'complete') {
            return this.rtcpc.localDescription
        
        // else create a new promise to wait complete
        } else {
            return await new Promise((resolve) => {

                // add this event listener to the rtcpc to check ice state
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
            this.setLocalOfferAndSend()
        })
    }

    // datachannels functions

    createDataChannels() {
        this.createDataChannel({
            label: 'sdp',
            onMessage: (event) => { sdpChannelOnMessage(event, this) }
        })

        this.createDataChannel({
            label: 'id',
            onMessage: (event) => { idChannelOnMessage(event, this) },
            onOpen: (event) => { idChannelOnOpen(event, this) }
        })
    }
    
    createDataChannel({label, onMessage, onOpen, onClose}) {
        const dataChannel = {
            sendChannel: this.rtcpc.createDataChannel(label),
            receiveChannel: null,
            onMessage: onMessage,
            onOpen: onOpen,
            onClose: onClose,
        }
        this.dataChannels[label] = dataChannel
    }

    sendMessage(label, message) {
        // triggers remote peer datachannel message event
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
            this.gui.label.innerText = `Connection Remote Peer Id: ${this.remotePeerId}`
            this.streamsGui.label.innerText = `Streams Remote Peer Id: ${this.remotePeerId}`
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
            negotiationTextarea.readOnly = true
            negotiationGui.label.innerText = 'Connection Description: '

            // get a and show new offer
            let localDescription = await this.setLocalOfferAndSend()
            negotiationTextarea.value = JSON.stringify(localDescription)

            // deal with subsequent pasted offers or answers
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
                    localDescription = await this.receiveDescription(pastedDescription)
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

function idChannelOnOpen(event, connectionInstance) {
    connectionInstance.sendMessage('id', LOCAL_PEER.id)
}

function idChannelOnMessage(event, connectionInstance) {
    connectionInstance.remotePeerId = JSON.parse(event.data)
    connectionInstance.updateGuiLabel()
    LOCAL_PEER.addConnection(connectionInstance)
}

async function sdpChannelOnMessage(event, connectionInstance) {
    const description = new RTCSessionDescription(JSON.parse(event.data))
    connectionInstance.receiveDescription(description)
}

const MAIN_GUI = new BaseGui({label: 'Main Gui'})
const LOCAL_PEER_PARENT = MAIN_GUI.appendElement('div')
const STREAMS_GUI = new BaseGui({parent: MAIN_GUI.innerContainer, label: 'Streams'})
const CONNECTIONS_PARENT = MAIN_GUI.appendElement('div')
/*
const STREAMS_PARENT  = MAIN_GUI.appendElement('div')
const DATA_CHANNELS_PARENT = MAIN_GUI.appendElement('div')
const CONNECTIONS_PARENT = MAIN_GUI.appendElement('div')
const STREAMS_GUI = new StreamsGui({parent: STREAMS_PARENT, label: 'Send Streams'})
*/

const LOCAL_PEER = new LocalPeer()

function generateUUID() {
    const crypto = window.crypto
    if (crypto) {
      return crypto.randomUUID()
    } else {
      throw new Error('Crypto API not available')
    }
}

