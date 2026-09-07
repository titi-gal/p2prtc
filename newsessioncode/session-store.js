/* INDEXED DB */

let DB;
const DB_VERSION = 1
const DB_NAME = "p2prtc"
const DB_STORE_NAME = "session"
const DB_STORE_FIELD_NAME = "name"
const DB_STORE_FIELD_PASSWORD = "password"
const DB_STORE_FIELD_DATA = "data"

async function openDB() {
    if (DB) {
        return
    }

    return new Promise((resolve, reject) => {
        const DBOpenRequest = window.indexedDB.open(
            DB_NAME,
            DB_VERSION
        )

        DBOpenRequest.onblocked = event => {
            console.log("DBOpenRequest blocked", event)
            reject(event)
        }

        DBOpenRequest.onerror = event => {
            console.log("DBOpenRequest error", event)
            reject(event.target.error)
        }

        DBOpenRequest.onupgradeneeded = event => {
            console.log("DBOpenRequest upgrade needed", event)

            DB = event.target.result

            DB.createObjectStore(
                DB_STORE_NAME,
                {
                    keyPath: DB_STORE_FIELD_NAME
                }
            )
        }

        DBOpenRequest.onsuccess = event => {
            console.log("DBOpenRequest success", event)
            DB = event.target.result
            resolve()
        }
    })
}

async function DBAddSession(name, passwordHash, encryptedData) {
    const session = {
        [DB_STORE_FIELD_NAME]: name,
        [DB_STORE_FIELD_PASSWORD]: passwordHash,
        [DB_STORE_FIELD_DATA]: encryptedData
    }

    const request = DB
    .transaction(DB_STORE_NAME, "readwrite")
    .objectStore(DB_STORE_NAME)
    .add(session)

    return new Promise((resolve, reject) => {
        request.onsuccess = event => {
            resolve(event.target.result)
        }

        request.onerror = event => {
            reject(event.target.error)
        }
    })
}

async function DBGetSession(name) {
    const request = DB
        .transaction(DB_STORE_NAME, "readonly")
        .objectStore(DB_STORE_NAME)
        .get(name)

    return new Promise((resolve, reject) => {
        request.onsuccess = event => {
            resolve(event.target.result)
        }

        request.onerror = event => {
            reject(event.target.error)
        }
    })
}

async function DBPutSession(name, passwordHash, encryptedData) {
    const session = {
        [DB_STORE_FIELD_NAME]: name,
        [DB_STORE_FIELD_PASSWORD]: passwordHash,
        [DB_STORE_FIELD_DATA]: encryptedData
    }

    const request = DB
        .transaction(DB_STORE_NAME, "readwrite")
        .objectStore(DB_STORE_NAME)
        .put(session)

    return new Promise((resolve, reject) => {
        request.onsuccess = event => {
            resolve(event.target.result)
        }

        request.onerror = event => {
            reject(event.target.error)
        }
    })
}

async function DBDeleteSession(name) {
    const request = DB
        .transaction(DB_STORE_NAME, "readwrite")
        .objectStore(DB_STORE_NAME)
        .delete(name)

    return new Promise((resolve, reject) => {
        request.onsuccess = event => {
            resolve(event.target.result)
        }

        request.onerror = event => {
            reject(event.target.error)
        }
    })
}

/* CRYPTO */

// Password Hashing

const PBKDF2_ITERATIONS = 150000
const PASSWORD_SALT_LENGTH = 16
const ENCRYPTION_SALT_LENGTH = 16
const AES_GCM_IV_LENGTH = 12

function randomBytes(length) {
    return crypto.getRandomValues(new Uint8Array(length))
}

function encode(data) {
    const encoder = new TextEncoder()
    return encoder.encode(data)
}

function decode(data) {
    const decoder = new TextDecoder()
    return decoder.decode(data)
}

async function hashPassword(plaintextPassword, salt) {

    // Generate a salt if not given.
    if (!salt) {
        salt = randomBytes(PASSWORD_SALT_LENGTH)
    }

    // Turn the password into a CryptoKey.
    const baseKey = await crypto.subtle.importKey(
        "raw",
        encode(plaintextPassword),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    )

    // Derive a 256-bit password hash.
    const hashBuffer = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: PBKDF2_ITERATIONS,
            hash: "SHA-256"
        },
        baseKey,
        256
    )

    return {
        salt: salt,
        hash: new Uint8Array(hashBuffer)
    }
}

async function checkPassword(plaintextPassword, storedPassword) {

    const calculatedPassword = await hashPassword(
        plaintextPassword,
        storedPassword.salt
    )

    const calculatedHash = calculatedPassword.hash
    const storedHash = storedPassword.hash

    if (calculatedHash.length !== storedHash.length) {
        return false
    }

    // Constant-time comparison.
    let difference = 0

    for (let i = 0; i < calculatedHash.length; i++) {
        difference |= calculatedHash[i] ^ storedHash[i]
    }

    return difference === 0
}


// Session Encryption

async function generateKey(salt, plaintextPassword) {

    const baseKey = await crypto.subtle.importKey(
        "raw",
        encode(plaintextPassword),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    )

    const baseKeyAlgorithm = {
        name: "PBKDF2",
        salt: salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256"
    }

    const derivedKeyAlgorithm = {
        name: "AES-GCM",
        length: 256
    }

    return await crypto.subtle.deriveKey(
        baseKeyAlgorithm,
        baseKey,
        derivedKeyAlgorithm,
        false,
        ["encrypt", "decrypt"]
    )
}


async function encryptData(plaintextPassword, data, salt, iv) {

    // Generate salt and IV if not given.
    if (!salt) {
        salt = randomBytes(ENCRYPTION_SALT_LENGTH)
    }

    if (!iv) {
        iv = randomBytes(AES_GCM_IV_LENGTH)
    }

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        await generateKey(salt, plaintextPassword),
        encode(data)
    )

    return {
        salt: salt,
        iv: iv,
        ciphertext: ciphertext
    }
}


async function decryptData(plaintextPassword, salt, iv, ciphertext) {

    const decrypted = await crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        await generateKey(salt, plaintextPassword),
        ciphertext
    )

    return decode(decrypted)
}


/* PEER AND SESSION MANAGEMENT */

async function authenticateSession(name, plaintextPassword) {
    // Get session.
    const session = await DBGetSession(name)
    if (!session) {
        throw new Error("No session with this peer name")
    }

    // Verify password.
    const valid = await checkPassword(
        plaintextPassword,
        session[DB_STORE_FIELD_PASSWORD]
    )
    if (!valid) {
        throw new Error("Wrong password")
    }
    return session
}

async function newSession(name, plaintextPassword, data) {
    // Create password verification data.
    const passwordHash = await hashPassword(plaintextPassword)

    const encryptedData = await encryptData(
        plaintextPassword,
        JSON.stringify(data)
    )

    // Add to DB.
    await DBAddSession(
        name,
        passwordHash,
        encryptedData
    )
}

async function openSession(name, plaintextPassword) {
    const session = await authenticateSession(name, plaintextPassword)

    // Decrypt the data.
    const encryptedData = session[DB_STORE_FIELD_DATA]

    const decryptedData = JSON.parse(
        await decryptData(
            plaintextPassword,
            encryptedData.salt,
            encryptedData.iv,
            encryptedData.ciphertext
        )
    )

    return {
        name: session[DB_STORE_FIELD_NAME],
        data: decryptedData
    }
}

async function saveSession(name, plaintextPassword, data) {
    const session = await authenticateSession(name, plaintextPassword)

    // encrypt peer's data
    const encryptedData = await encryptData(
        plaintextPassword,
        JSON.stringify(data)
    )

    // put on db
    await DBPutSession(
        session[DB_STORE_FIELD_NAME],
        session[DB_STORE_FIELD_PASSWORD],
        encryptedData
    )
}

async function deleteSession(name, plaintextPassword) {
    const session = await authenticateSession(name, plaintextPassword)
    await DBDeleteSession(session[DB_STORE_FIELD_NAME])
}