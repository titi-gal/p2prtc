self.addEventListener("install", (event) => {
    console.log("service worker install event")
    console.log(event)
})

self.addEventListener("activate", (event) => {
    console.log("service worker activate event")
    console.log(event)
})