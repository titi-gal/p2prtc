class localPeer {
    constructor(connectionConfig) {
        this.id = generateUUID()
        this.connectionConfig = connectionConfig
        this.connections = new UniqueObjectsWithGui()
        this.sendStreams = new UniqueObjectsWithGui()
    }

    getFirstOffer(id) {
        // add new connection
        // return offer of new connection
    }

    setFirstOfferOrAnswer() {
        // if offer
            // add a 
            // return answer of connection

        // if answer
            // get connection that made the offer
            // accept the answer
    }

    addNewConnection(id) {
    }

    removeConnection(connection) {
    }

    addStream(stream) {
    }

    removeStream(stream) {
    }

    newUserStream() {
    }

    newDisplayStream() {
    }
}

class Connection {
}

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
    constructor(label='', parent=document.querySelector('body')) {
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
    constructor(removeCallback=()=>{}) {
        this.removeCallback = removeCallback
        this.objects = new Map()
        this.htmlElementsCallbacks = new Set()
        this.elements = new Map()
    }

    add(object) {
        if (!object.id) {
            throw new Error('objects must have a unique value named id')
        }

        if (!this.objects.has(object.id)) {
            // add object
            this.objects.set(object.id, object)

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
        if (this.objects.has(object.id)) {
            // remove object
            this.objects.delete(object.id)
            
            // remove all object elements
            this.elements.get(object.id).forEach(element => element.remove())

            // remove elements list
            this.elements.delete(object.id)
            return true
        }
        return false
    }

    get(id) {
        // abstracts objects.get
        return this.objects.get(id)
    }

    forEach(callback) {
        // abstracts objects.forEach
        return this.objects.forEach(callback)
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

function generateUUID() {
    const crypto = window.crypto
    if (crypto) {
      return crypto.randomUUID()
    } else {
      throw new Error('Crypto API not available')
    }
}