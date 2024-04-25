class BaseGui {
    constructor({parent, container} = {}) {
        this.parent = parent || document.querySelector('body')
        this.container = container || document.createElement('div')
        if (!container) {
            this.parent.append(this.container)
        } else {
            this.parent = this.container.parentElement
        }
    }

    kill() {
        this.container.remove()
    }

    appendElement(name) {
        const element = document.createElement(name)
        this.container.append(element)
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
            this.container.appendChild(videoElement)
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
        return this.container.querySelector(`[id="${stream.id}"]`)
    }
}

class LocalPeer {
    constructor(config) {
        this.id = generateUUID()
        this.config = config
        this.connections = {}
        this.sendStreams = {}
        this.streamsGui = STREAMS_GUI
        this.createGui()
    }

    newConnection() {
        new Connection(this.config)
    }

    addConnection(connectionInstance) {
        // connection data channel calls this.addConnection() once it received remote peer id, just after connected
        
        // if connection id in not peer id and not other connectios ids
        if (connectionInstance.id !== this.id && !this.connections[connectionInstance.id]) {
            // store this connection in connections
            this.connections[connectionInstance.id] = connectionInstance
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
        this.gui = new BaseGui({container: LOCAL_PEER_CONTAINER})

        const newConnectionButton = this.gui.appendButton('New Connection')
        const addUserStreamButton = this.gui.appendButton('Add User Stream')
        const addDisplayStreamButton = this.gui.appendButton('Add Display Stream')
        newConnectionButton.addEventListener('click', () => {
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
        this.id = null // remote peer sends its id once connected
        this.reset()
        this.open()
    }

    reset() {
        // rtcpc exists and its not closed
        if (this.rtcpc && this.rtcpc.connectionState !== 'closed') {
            // stop sending all streams
            this.connection.getSenders().forEach(sender => {
                this.connection.removeTrack(sender)
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
        }

        // set every property to initial state
        this.rtcpc = null // rtcpc means RTCPeerConnection
        this.refuseOnOfferConflict = null
        this.streamsGui = STREAMS_GUI
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
            // removes each track of the stream from the connection, will stop sending it to remote peer
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

    async setRemoteOfferSetLocalAndSend(description) {
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

    createGui() {
        this.gui = new BaseGui({parent: CONNECTIONS_PARENT})

        const negotiationGui = async () => {
            // negotiation elements
            const negotiationLabel = this.gui.appendElement('label')
            const negotiationTextarea = this.gui.appendElement('textarea')
            negotiationTextarea.readOnly = true
            negotiationLabel.innerText = 'Connection Negotiation:'

            // get a and show new offer
            const localDescripton = await this.setLocalOfferAndSend()
            const descriptionString = JSON.stringify(localDescripton)
            negotiationLabel.innerText = "Send this OR paste received:"
            negotiationTextarea.value = descriptionString

            // deal with subsequent pasted offers or answers
            negotiationTextarea.addEventListener('paste', async (event) => {

                // get description
                let pastedDescription
                try {
                    pastedDescription = JSON.parse(event.clipboardData.getData('text'))
                } catch (error) {
                    negotiationTextarea.value = `error parsing JSON: ${error.toString()}`
                }

                // if description is offer set it as remote and, set a new local and shows it
                if (pastedDescription.type === 'offer') {
                    const localDescripton = await this.setRemoteOfferSetLocalAndSend(pastedDescription)
                    const descriptionString = JSON.stringify(localDescripton)
                    negotiationLabel.innerText = 'Now send this AND paste received:'
                    negotiationTextarea.value = descriptionString
                    
                // if description is answer set it as remote
                } else if (pastedDescription.type === 'answer') {
                    await this.setRemoteAnswer(pastedDescription)
                } else {
                    negotiationTextarea.value = 'not a offer or answer description'
                }
            })

            negotiationTextarea.addEventListener('click', () => {
                negotiationTextarea.select()
            })
        }

        const statesGui = () => {
            const statesLabel = this.gui.appendElement('label')
            const statesTextarea = this.gui.appendElement('textarea')
            statesTextarea.hidden = true
            statesLabel.innerText = 'Connection States:'

            const updateStates = () => {
                statesTextarea.value =
                `Connection: ${this.rtcpc.connectionState}\n` +
                `Signaling: ${this.rtcpc.signalingState}\n` +
                `Ice Gathering: ${this.rtcpc.iceGatheringState}\n` +
                `Ice Connection: ${this.rtcpc.iceConnectionState}`
            }

            statesLabel.addEventListener('click', () => {
                statesTextarea.toggleAttribute('hidden')
            })
            
            updateStates()
            this.rtcpc.addEventListener('connectionstatechange', updateStates)
            this.rtcpc.addEventListener('iceconnectionstatechange', updateStates)
            this.rtcpc.addEventListener('icegatheringstatechange', updateStates)
            this.rtcpc.addEventListener('signalingstatechange', updateStates)


        }

        const statsGui = () => {
            const statsLabel = this.gui.appendElement('label')
            const statsTextarea = this.gui.appendElement('textarea')
            statsTextarea.hidden = true
            statsLabel.innerText = 'Connection Stats:'

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
                        if (statName !== "id" &&
                            statName !== "timestamp" &&
                            statName !== "type") {
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

            statsLabel.addEventListener('click', (event) => {
                if (statsTextarea.hidden) {
                    startStats()
                    statsTextarea.hidden = false
                } else {
                    stopStats()
                    statsTextarea.hidden = true
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
    connectionInstance.id = JSON.parse(event.data)
    LOCAL_PEER.addConnection(connectionInstance)
}

async function sdpChannelOnMessage(event, connectionInstance) {
    const description = new RTCSessionDescription(JSON.parse(event.data))
    if (// if have local offer and
        connectionInstance.rtcpc.signalingState === 'have-local-offer' &&
        // received offer and
        description.type === 'offer' &&
        // should refuse on offer conflict
        connectionInstance.refuseOnOfferConflict) {
            // do nothing, answer will come from remote peer
            return  null

    } else if (description.type === 'offer') {
        await connectionInstance.setRemoteOfferSetLocalAndSend(description)
    } else if (description.type === 'answer') {
        await connectionInstance.setRemoteAnswer(description)
    }
}

const MAIN_GUI = new BaseGui()
const LOCAL_PEER_CONTAINER = MAIN_GUI.appendElement('div')
const STREAMS_CONTAINER  = MAIN_GUI.appendElement('div')
const DATA_CHANNELS_PARENT = MAIN_GUI.appendElement('div')
const CONNECTIONS_PARENT = MAIN_GUI.appendElement('div')
const STREAMS_GUI = new StreamsGui({container: STREAMS_CONTAINER})

const LOCAL_PEER = new LocalPeer()

function generateUUID() {
    const crypto = window.crypto
    if (crypto) {
      return crypto.randomUUID()
    } else {
      throw new Error('Crypto API not available')
    }
}

