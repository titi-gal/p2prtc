class LocalPeer {
    constructor(config) {
        this.id = generateUUID()
        this.config = config
        this.connections = new UniqueObjectsWithGui()
        this.sendStreams = new UniqueObjectsWithGui((stream) => { this.removeStream(stream) })
    }

    addNewConnection(id) {
        // create new connection instance and adds it to connections
        const connection = new Connection(this.config, id)
        const addedIfUnique = this.connections.add(connection)
        if (addedIfUnique) {
            console.log(`added connection id ${connection.id}`)

            // if connection is not connected for sometime it gets removed
            const removeConnectionTimeout = setTimeout(() => {
                console.log(`idle connection id ${connection.id}`)
                this.removeConnection(connection)
            }, 5 * 60 * 1000) // 1 minute in milliseconds

            // when connection state changes
            connection.rtcpc.addEventListener("connectionstatechange", (event) => {
                console.log(`connection state changed to ${connection.rtcpc.connectionState} connection id ${connection.id}`)
                // connected
                if (connection.rtcpc.connectionState === 'connected') {
                    // its being used, clear removeConnectionTimeout
                    clearTimeout(removeConnectionTimeout)
                    console.log(`added all send streams to connection id ${connection.id}`)
                }
                // unrecoverable states
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
        const removedIfWasAdded = this.connections.remove(connection)
        if (removedIfWasAdded) {
            connection.reset()
            console.log(`removed connection id ${connection.id}`)
        } else {
            console.log(`could not remove connection, id ${connection.id} does not exists`)
        }
    }

    addStream(stream) {
        const addedIfUnique = this.sendStreams.add(stream)
        if (addedIfUnique) {
            // add stream to all connections
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
    }

    removeStream(stream) {
        const removedIfWasAdded = this.sendStreams.remove(stream)
        if (removedIfWasAdded) {
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
            // updates and returns connections if exists
            const connection = this.connections.update(firstDescription.connectionId, firstDescription.fromId)
            if (connection) {
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
            // remove all streams and its elements
            this.sendStreams.forEach(stream => this.sendStreams.remove(stream))
            this.receiveStreams.forEach(stream => this.receiveStreams.remove(stream))
            // closes the connection
            this.rtcpc.close()
        }

        // set every property to initial state
        this.rtcpc = null
        this.refuseIfOfferConflict = null // TODO make peers fight over this once connected
        this.dataChannels =  new UniqueObjectsWithGui()
        this.sendStreams = new UniqueObjectsWithGui()
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
        const addedIfUnique = this.sendStreams.add(stream)
        if (addedIfUnique) {
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
        const removedIfWasAdded = this.sendStreams.remove(stream)
        if(removedIfWasAdded) {
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
            // event receives the same stream for each track of the stream
            // the stream is added on the first track received, the rest is ignored
            const addedIfUnique = this.receiveStreams.add(stream)
            if (addedIfUnique) {
                console.log(`received stream id ${stream.id}`)
                // add event to remove stream when remote peer calls removeStream()
                stream.addEventListener('removetrack', event => {
                    // removes it
                    this.receiveStreams.remove(stream)
                    console.log(`removed receive stream id ${stream.id} from connection id ${this.id}`)
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
        this.sendMessage('description', this.rtcpc.localDescription)

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
            this.sendMessage('icecandidate', event)
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
            label: 'description',
            onMessage: descriptionChannelOnMessage,
            onOpen: sdpChannelOnOpen
        })
        this.createDataChannel({
            label: 'firstdescription',
            onMessage: firstDescriptionChannelOnMessage,
            onOpen: firstDescriptionChannelOnOpen
        })
        this.createDataChannel({
            label: 'icecandidate',
            onMessage: iceCandidateChannelOnMessage,
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
                    console.log(`connection id ${this.id} relayed message on datachannel label ${event.target.label} from ${message.to} ${message.to}`)
                }
                // ignored if local peer doesn't have a connection to destination peer
                console.log(`message ignored to connection id ${message.to}`)

            // receive message that doesn't have a destination peer or destination is local peer
            } else {
                console.log(`connection id ${this.id} received message from peer ${message.from} on datachannel label ${event.target.label}`)
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
            console.log(`connection id ${this.id} sent message to peer ${message.to} on datachannel label ${label}`)
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

// datachannel and general functions

async function firstDescriptionChannelOnOpen(event, connection) {

    connection.sendMessage('firstdescription', {ids: Array.from(LOCAL_PEER.connections.keys())})
}

async function firstDescriptionChannelOnMessage(event, connection) {
    const message = JSON.parse(event.data)
    if (message.message.firstDescription) {
        const firstDescription = message.message.firstDescription
        const firstAnswer = await LOCAL_PEER.setFirstOfferOrAnswer(firstDescription)
        if (firstAnswer) {
            connection.sendMessage('firstdescription', {firstDescription: firstAnswer}, message.from)
        }
    } else if (message.message.ids) {
        const ids = message.message.ids
        const unconnectedIds = ids.filter( id => {return id !== LOCAL_PEER.id && !LOCAL_PEER.connections.has(id)})
        unconnectedIds.forEach(async (id) => {
            const firstOffer = await LOCAL_PEER.getFirstOffer()
            connection.sendMessage('firstdescription', {firstDescription: firstOffer}, id)
        })
    }
}

async function descriptionChannelOnMessage(event, connection) {
    const description = new RTCSessionDescription(JSON.parse(event.data).message)
    connection.receiveOfferOrAnswer(description)
}

function sdpChannelOnOpen(event, connection) {
    // add all current streams to connection
    LOCAL_PEER.sendStreams.forEach(stream => {
        connection.addStream(stream)
    })
}

function generateUUID() {
    const crypto = window.crypto
    if (!crypto) {
        throw new Error('Crypto API not available')
    }
    return crypto.randomUUID()
}

function iceCandidateChannelOnMessage(event, connection) {
    const message = JSON.parse(event.data).message
    connection.rtcpc.addIceCandidate(message.candidate)
}

// GUI Classes

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

class UniqueObjectsWithGui extends Map {
    constructor(removeCallback = () => {}) {
        super()
        this.removeCallback = removeCallback;
        this.htmlElementsCallbacks = new Set()
        this.elements = new Map()
    }

    update(oldId, newId) {
        if (this.has(oldId)) {
            const object = this.get(oldId)
            this.delete(object.id)
            object.id = newId
            this.set(object.id, object)
            return object
        }
        return null
    }

    add(object) {
        if (!object.id) {
            throw new Error('objects must have a unique value named id')
        }

        if (!this.has(object.id)) {
            // add object
            this.set(object.id, object)

            // add a list to store object elements
            this.elements.set(object.id, [])
            const elements = this.elements.get(object.id)

            // create and store object elements created with htmlElementsCallbacks
            this.htmlElementsCallbacks.forEach(htmlElementCallback => {
                const htmlElement = htmlElementCallback(object, this.removeCallback)
                if (htmlElement instanceof HTMLElement) {
                    elements.push(htmlElement)
                } else {
                    throw new Error('htmlElementCallback must return a instance of HTMLElement')
                }
            })
            return true
        }
        return false
    }

    remove(object) {
        if (this.has(object.id)) {
            // remove object
            this.delete(object.id)
            
            // remove all object elements
            this.elements.get(object.id).forEach((element) => {
                element.remove()
            })

            // remove elements list
            this.elements.delete(object.id)
            return true
        }
        return false
    }

    addHtmlElement(htmlElementCallback) {
        // function should be in specs below
        // (object, removeCallback) => {return htmlElement}
        // optionally call removeCallback(object) inside function
        this.htmlElementsCallbacks.add(htmlElementCallback)
    }

    removeHtmlElement(htmlElementCallback) {
        this.htmlElementsCallbacks.delete(htmlElementCallback)
    }
}

// create local peer instance

const LOCAL_PEER = new LocalPeer()
const localPeerContainer = new LabeledContainer({label: `Local Peer id ${LOCAL_PEER.id}`})

// local peer gui

const streamsButtonsContainer = new LabeledContainer({
    label: 'Add Streams:',
    parent: localPeerContainer.innerContainer

})

const addUserStreamButton = streamsButtonsContainer.appendButton('Add User Stream')
const addDisplayStreamButton = streamsButtonsContainer.appendButton('Add Display Stream')

addUserStreamButton.addEventListener('click', () => {
    LOCAL_PEER.addUserStream()
})
addDisplayStreamButton.addEventListener('click', () => {
    LOCAL_PEER.addDisplayStream()
})

const newConnectionContainer = new LabeledContainer({
    label: 'Add Connection:',
    parent: localPeerContainer.innerContainer
})

const localPeerSendStreamsContainer = new LabeledContainer({
    label: 'Send Streams:',
    parent: localPeerContainer.innerContainer

})

const connectionConfigContainer = new LabeledContainer({label: 'Configuration:', parent:newConnectionContainer.innerContainer})
const connnectionConfigTextarea = connectionConfigContainer.appendElement('textarea')
connnectionConfigTextarea.value = '{}'

const connectionDescription = new LabeledContainer({label: 'Description:', parent:newConnectionContainer.innerContainer})
const descriptionTextarea = connectionDescription.appendElement('textarea')
const GetOfferButton = connectionDescription.appendButton('Get Offer')

GetOfferButton.addEventListener('click', async () => {
    LOCAL_PEER.config = JSON.parse(connnectionConfigTextarea.value)
    const firstOffer = await LOCAL_PEER.getFirstOffer()
    const firstOfferString = JSON.stringify(firstOffer)
    await navigator.clipboard.writeText(firstOfferString)
    descriptionTextarea.value = firstOfferString
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
            const firstAnswerString = JSON.stringify(firstAnswer)
            await navigator.clipboard.writeText(firstAnswerString)
            event.target.value = firstAnswerString
        } else {
            event.target.value = ''
        }
    } catch (error) {
        event.target.value = `error receiving description: ${error.toString()}`
    }
})

descriptionTextarea.addEventListener('mousedown', (event) => {
    event.preventDefault()
    descriptionTextarea.select()
})

const streamVideoElements = new LabeledContainer({label: 'Streams:'})
const connectionsContainer = new LabeledContainer({
    label: 'Connections:'})

LOCAL_PEER.connections.addHtmlElement((connection, removeCallback) => {
    const connectionContainer = new LabeledContainer({
        label: `${connection.id} ${connection.rtcpc.connectionState} `,
        parent: connectionsContainer.innerContainer})

    const sendStreamsContainer = new LabeledContainer({
        label: 'Send Streams:',
        parent: connectionContainer.innerContainer
    })

    const receiveStreamsContainer = new LabeledContainer({
        label: 'Receive Streams:',
        parent: connectionContainer.innerContainer
    })

    connection.rtcpc.addEventListener('connectionstatechange', () => {
        connectionContainer.label.innerText = `${connection.id} ${connection.rtcpc.connectionState}`
    })

    connection.sendStreams.addHtmlElement((stream, removeCallback) => {
        const streamElement = sendStreamsContainer.appendElement('div')
        streamElement.innerText = stream.id
        return streamElement
    })

    connection.receiveStreams.addHtmlElement((stream, removeCallback) => {
        const streamElement = receiveStreamsContainer.appendElement('div')
        streamElement.innerText = stream.id
        return streamElement
    })

    connection.receiveStreams.addHtmlElement((stream, removeCallback) => {
        const videoElement = streamVideoElements.appendElement('video')
        videoElement.id = stream.id
        videoElement.srcObject = stream
        videoElement.controls = true
        videoElement.play()
        return videoElement
    })

    return connectionContainer.OuterContainer
})


LOCAL_PEER.sendStreams.addHtmlElement((stream, removeCallback) => {
    const videoElement = streamVideoElements.appendElement('video')
    videoElement.id = stream.id
    videoElement.srcObject = stream
    videoElement.controls = true
    videoElement.muted = true
    videoElement.play()

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
        removeCallback(stream)
    })
    return videoElement
})

LOCAL_PEER.sendStreams.addHtmlElement((stream, removeCallback) => {
    const streamElement = localPeerSendStreamsContainer.appendElement('div')
    streamElement.innerText = stream.id
    streamElement.addEventListener('click', () => {
        removeCallback(stream)
    })
    return streamElement    
})