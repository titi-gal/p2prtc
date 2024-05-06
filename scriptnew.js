class LocalPeer {
    constructor(config) {
        this.id = generateUUID()
        this.config = config
        this.connections = new UniqueObjectsWithGui((connection) => { this.removeConnection(connection) }, {label: 'Connections: '})
        this.sendStreams = new UniqueObjectsWithGui((stream) => { this.removeStream(stream) }, {label: 'Streams:'})
    }

    addNewConnection(id) {
        // create new connection instance and adds it to the map of connections
        const connection = new Connection(this.config, id)
        const wasAdded = this.connections.add(connection)
        if (wasAdded) {
            console.log(`added connection id ${connection.id}`)

            // if connection is not connected for sometime it gets removed
            const removeConnectionTimeout = setTimeout(() => {
                console.log(`idle connection id ${connection.id}`)
                this.removeConnection(connection)
            }, 1 * 60 * 1000) // 1 minute in milliseconds

            // when connection state changes
            connection.rtcpc.addEventListener("connectionstatechange", (event) => {
                console.log(`connection state changed to ${connection.rtcpc.connectionState} connection id ${connection.id}`)

                // connected
                if (connection.rtcpc.connectionState === 'connected') {
                    // its being used, clear removeConnectionTimeout
                    clearTimeout(removeConnectionTimeout)
                    // add all current streams to connection
                    this.sendStreams.forEach(stream => {
                        connection.addStream(stream)
                    })
                    console.log(`added all send streams to connection id ${connection.id}`)
                }

                // unrecoverable state
                if (connection.rtcpc.connectionState === 'failed' ||
                connection.rtcpc.connectionState === 'disconnected' ||
                connection.rtcpc.connectionState === 'closed') {
                    // remove connection
                    this.removeConnection(connection)
                    // TODO try to reconnect somehow
                }
            })
            return connection
        }
        console.log(`could not add connection, id ${id} already exists`)
        return null
    }

    removeConnection(connection) {
        const wasRemoved = this.connections.remove(connection)
        if (wasRemoved) {
            connection.reset()
            console.log(`removed connection id ${connection.id}`)
        } else {
            console.log(`could not remove connection, id ${connection.id} does not exists`)
        }
        return wasRemoved
    }

    addStream(stream) {
        const wasAdded = this.sendStreams.add(stream)
        if (wasAdded) {
            this.connections.forEach(connection => {
                if (connection.rtcpc.connectionState === 'connected') {
                    connection.addStream(stream)
                }
                console.log(`connectiond id ${connection.id} is not connected, state ${connection.rtcpc.connectionState}`)
            })
            console.log(`added stream id ${stream.id} to all connected connections`)
        } else {
            console.log(`could not add stream id ${stream.id}, already exists`)
        }
        return wasAdded
    }

    removeStream(stream) {
        const wasRemoved = this.sendStreams.remove(stream)
        if (wasRemoved) {
            this.connections.forEach(connection => {
                if (connection.rtcpc.connectionState === 'connected') {
                    connection.removeStream(stream)
                }
                console.log(`connectiond id ${connection.id} is not connected, state ${connection.rtcpc.connectionState}`)
            })
            stream.getTracks().forEach(track => {
                track.stop()
            })
            console.log(`removed stream id ${stream.id} from all connected connections`)
        } else {
            console.log(`could not remove stream id ${stream.is}, does not exist`)
        }
        return wasRemoved
    }

    async getFirstOffer() {
        // creates a connection and gets an offer for it
        const connection = this.addNewConnection()
        const offer = await connection.sendOffer()
        const firstDescription = {
            fromId: this.id,
            connectionId: connection.id,
            description: offer
        }
        console.log(`created first offer connection id ${firstDescription.connectionId}`)
        return firstDescription
    }

    async setFirstOfferOrAnswer(firstDescription) {

        // creates a connection with fromId (thats the remote peer id) to receive an offer
        if(firstDescription.description.type === 'offer') {
            const connection = this.addNewConnection(firstDescription.fromId)
            if (connection) {
                // receive the offer and return the answer
                const answer = await connection.receiveOfferOrAnswer(firstDescription.description)
                console.log(`received first offer of remote peer id ${firstDescription.fromId} connection id ${firstDescription.connectionId}`)
                return {
                    fromId: this.id,
                    connectionId: firstDescription.connectionId,
                    description: answer
                }
            }

        // retrives the connection that made the offer to receive an answer
        } else if (firstDescription.description.type === 'answer') {
            const connection = this.connections.get(firstDescription.connectionId)
            if (connection) {

                // update connection id to be remote peer id
                this.connections.remove(connection)
                connection.id = firstDescription.fromId
                this.connections.add(connection)

                // accept answer
                await connection.receiveOfferOrAnswer(firstDescription.description)
                console.log(`received first answer from remote peer id ${firstDescription.fromId}`)
                return null
            }
        }
    }

    async addUserStream() {
        try {
            // get streams from, webcams, mics, etc
            const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true})
            // add stream to all connections and stores it
            this.addStream(stream)
        } catch (error) {
            console.log(`failed to get or add user media: ${error.toString()}`)
        }
    }

    async addDisplayStream() {
        // get streams from screen, window, tab
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({audio: true, video: true})
            // add stream to all connections and stores it
            this.addStream(stream)
        } catch (error) {
            console.log(`failed to get or add display media: ${error.toString()}`)
        }
    }
}

class Connection {
    constructor(config, id) {
        this.id = id || generateUUID() // this will be set as the remote peer id 
        this.config = config
        this.reset()
        this.open()
    }

    reset() {
        // connection exists and its not closed
        if (this.rtcpc && this.rtcpc.connectionState !== 'closed') {
            // stop sending all streams
            this.rtcpc.getSenders().forEach(sender => {
                this.rtcpc.removeTrack(sender)
            })
            // closes it
            this.rtcpc.close()
        }

        // set every property to initial state
        this.rtcpc = null
        this.refuseIfOfferConflict = null // TODO make peers fight over this once connected
        this.dataChannels =  new UniqueObjectsWithGui()
        this.sendStreams = new UniqueObjectsWithGui((stream) => { this.removeStream(stream) })
        this.receiveStreams = new UniqueObjectsWithGui()
    }

    open() {
        if (this.rtcpc) {
            if (this.rtcpc.connectionState === 'closed') {
                // connection is closed
                this.reset() // make sure all properties are in initual value
            } else {
                // connection is open, do nothing
                return
            }
        }

        this.rtcpc = new RTCPeerConnection(this.config)

        // this.rtcpc listeners, separated just for organization
        this.streamListener()
        this.dataChannelListener()
        this.negotiationListener()

        // there is a specific dataChannel object encapsulating the one given by webRTC
        this.createDataChannels()
    }

    // streams

    addStream(stream) {
        // add each track of the stream to the connection, will start sending to remote peer
        const wasAdded = this.sendStreams.add(stream)
        if (wasAdded) {
            stream.getTracks().forEach(track => {
                this.rtcpc.addTrack(track, stream)
            })
            console.log(`added send stream id ${stream.id} to connection id ${this.id}`)
        } else {
            console.log(`could not add stream id ${stream.id}, already exists`)
        }
    }

    removeStream(stream) {
        // removes each track of the stream from the connection, will stop sending to remote peer
        const wasRemoved = this.sendStreams.remove(stream)
        if(wasRemoved) {
            const senders = this.rtcpc.getSenders()
            stream.getTracks().forEach( track => {
                const sender = senders.find(sender => sender.track === track)
                this.rtcpc.removeTrack(sender)
            })
            console.log(`deleted send stream id ${stream.id} from connection id ${this.id}`)
        } else {
            console.log(`could not remove stream id ${stream.id}, stream does not exist`)
        }
    }

    streamListener() {
        // receive each track and the stream from remote peer that called addStream()
        this.rtcpc.addEventListener('track', event => {
            if (!event.streams.length === 1) {
                // the way addStrem is coded this event should aways receive a stream
                throw new Error(`event.streams.length is ${event.streams.length}, expected 1`)
            }
            const stream = event.streams[0]
            // if stream was not received before
            const wasAdded = this.receiveStreams.add(stream)
            if (wasAdded) {
                console.log(`received stream id ${stream.id}`)
                // add event to remove stream when remote peer calls removeStream()
                stream.addEventListener('removetrack', event => {
                    // removes it
                    console.log(`removed receive stream id ${stream.id} from connection id ${this.id}`)
                    this.receiveStreams.remove(stream)
                })
            }
        })
    }

    // negotitation functions

    async sendOffer() {
        await this.rtcpc.setLocalDescription()
        console.log(`created offer connection id ${this.id}`)
        return this.sendAndReturnLocalDescription()
    }

    async receiveOfferOrAnswer(description) {
        if (// receives an offer and signalingState is have-local-offer means an offer conflict
            description.type === 'offer' &&
            this.rtcpc.signalingState === 'have-local-offer' &&
            // one peer should aways refuse
            // other peer should aways accept
            this.refuseIfOfferConflict) {
                // refusing peer does nothing and wait for an answer
                return null

        // both peers (or accepting peer on offer conflict) processes an offer and sends an answer
        } else if (description.type === 'offer') {
            console.log(`received offer connection id ${this.id}`)
            await this.rtcpc.setRemoteDescription(description)
            await this.rtcpc.setLocalDescription()
            return await this.sendAndReturnLocalDescription()

        // both peers accepts answers in any case
        } else if (description.type === 'answer') {
            console.log(`received answer connection id ${this.id}`)
            await this.rtcpc.setRemoteDescription(description)
            return null
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
                // add this event listener to connection to check ice state
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
            console.log('icacandidate event')
            // TODO create a specific icecandidate datachannel and call connection.addIceCandidate() when onMessage
        })
        this.rtcpc.addEventListener('icecandidateerror', event => {
            // TOMAYBEDO
            console.log(`icecandidateerror: ${event.toString()}`)
        })
        this.rtcpc.addEventListener('negotiationneeded', event => {
            // data channel creation triggers this event when connection is new, which is not needed
            if (this.rtcpc.connectionState !== 'new') {
                console.log('negotiationneeded event')
                // create a new local description to start negotiation if connection is not new
                this.sendOffer()
            } else {
                console.log('negotiationneeded event ignored because connection is new')
            }
        })
    }

    // datachannels

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
                const toConnection = LOCAL_PEER.connections.get(message.to)
                if (toConnection) {
                    toConnection.sendMessage(event.target.label, message)
                    console.log(`message relayed from connection id ${message.from} to connection id ${toConnection.id} datachannel label ${event.target.label}`)
                }
                // ignored if local peer doesn't have a connection to destination peer
                console.log(`message ignored to connection id ${message.to}`)

            // receive message that doesn't have a destination peer or destination is local peer
            } else {
                console.log(`message received from peer ${message.from} datachannel label ${event.target.label}`)
                onMessage(event, this)
            }
        }

        const dataChannel = {
            id: label,
            sendChannel: this.rtcpc.createDataChannel(label),
            receiveChannel: null,
            onMessage: (event) => { receiveOrRelayMessage(event, this) },
            onOpen: (event) => { onOpen(event, this) },
            onClose: (event) => { onClose(event, this) },
        }
        this.dataChannels.add(dataChannel)
    }

    sendMessage(label, message, to=this.id) {
        const dataChannel = this.dataChannels.get(label)
        if (dataChannel && dataChannel.sendChannel.readyState  === 'open') {
            // triggers remote peer datachannel message event
            if (!message.from) {
                // create message metadata of it does not exist
                message = {
                    from: LOCAL_PEER.id,
                    to: to,
                    message: message
                }
            }
            console.log(`message send to peer ${message.to} datachannel label ${label} connection id ${this.id}`)
            dataChannel.sendChannel.send(JSON.stringify(message))
        }
    }

    dataChannelListener() {
        this.rtcpc.addEventListener('datachannel', event => {

            // adds received data channel to the corresponding datachannel object
            const dataChannel = this.dataChannels.get(event.channel.label)
            dataChannel.receiveChannel = event.channel

            // when receiving events
            // if dataChannel has a callback for the event, calls it

            dataChannel.receiveChannel.addEventListener('message', event => {
                dataChannel.onMessage(event)
            })
    
            dataChannel.receiveChannel.addEventListener('open', event => {
                dataChannel.onOpen(event)
            })

            dataChannel.receiveChannel.addEventListener('close', event => {
                dataChannel.onClose(event)
            })
        })
    }
}

// datachannel functions

async function sdpChannelOnMessage(event, connection) {
    const description = new RTCSessionDescription(JSON.parse(event.data).message)
    connection.receiveOfferOrAnswer(description)
}

// GUI

class LabeledContainer {
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

class UniqueObjectsWithGui {
    constructor(askToRemove=()=>{}, superParams = {}) {
        this.askToRemove = askToRemove
        this.objects = new Map()
        this.elements = new Map()
    }
    
    add(object) {
        if (!this.objects.has(object.id)) {
            this.objects.set(object.id, object)
            const element = this.createElement(object)
            this.elements.set(object.id, element)
            return true
        }
        return false
    }

    remove(object) {
        if (this.objects.has(object.id)) {
            this.objects.delete(object.id)
            const element = this.elements.get(object.id)
            element.remove()
            this.elements.delete(object.id)
            return true
        }
        return false
    }

    get(id) {
        const object = this.objects.get(id)
        if (object) {
            return object
        }
        return null
    }

    forEach(callback) {
        return this.objects.forEach(callback)
    }

    createElement(object) {
        // overwrite this to return a html element associated with the object
        // use this.askToRemove to make the class kill the object
        const element = document.createElement('div')
        element.innerText = object.id
        document.querySelector('body').append(element)
        element.addEventListener('click', () => {
            this.askToRemove(object)
        })
        return element
    }
}

function generateUUID() {
    const crypto = window.crypto
    if (!crypto) {
        throw new Error('Crypto API not available')
    }
    return crypto.randomUUID()
}

// create local peer instance

const LOCAL_PEER = new LocalPeer()

// streams gui

const streamsButtonsContainer = new LabeledContainer({label: 'Add Streams:'})
const addUserStreamButton = streamsButtonsContainer.appendButton('Add User Stream')
const addDisplayStreamButton = streamsButtonsContainer.appendButton('Add Display Stream')
addUserStreamButton.addEventListener('click', () => {
    LOCAL_PEER.addUserStream()
})
addDisplayStreamButton.addEventListener('click', () => {
    LOCAL_PEER.addDisplayStream()
})

// new connection gui

const newConnectionContainer = new LabeledContainer({label: 'Add Connections:'})

const connectionConfigContainer = new LabeledContainer({label: 'Configuration:', parent:newConnectionContainer.innerContainer})
const connnectionConfigTextarea = connectionConfigContainer.appendElement('textarea')
connnectionConfigTextarea.value = '{}'

const connectionDescription = new LabeledContainer({label: 'Description:', parent:newConnectionContainer.innerContainer})
const descriptionTextarea = connectionDescription.appendElement('textarea')
const GetOfferButton = connectionDescription.appendButton('Get Offer')

GetOfferButton.addEventListener('click', async () => {
    LOCAL_PEER.config = JSON.parse(connnectionConfigTextarea.value)
    const firstOffer = await LOCAL_PEER.getFirstOffer()
    descriptionTextarea.value = JSON.stringify(firstOffer)
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

    // receive offer or answer
    try {
        const firstAnswer = await LOCAL_PEER.setFirstOfferOrAnswer(pastedDescription)
        // show answer if it exists
        if (firstAnswer) {
            event.target.value = JSON.stringify(firstAnswer)
        } else {event.target.value = ''}
    } catch (error) {
        event.target.value = `error receiving description: ${error.toString()}`
    }
})