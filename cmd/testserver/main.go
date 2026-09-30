// Command testserver runs the fixture API of the end-to-end tests.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/g0itb4/wirebook/internal/testserver"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:18080", "the address to listen on")
	origin := flag.String("cors-origin", "", "the origin allowed to call from a browser; empty for no CORS")
	pace := flag.Duration("pace", 50*time.Millisecond, "the wait between the messages of a stream")
	flag.Parse()

	handler, err := testserver.New(testserver.Options{CORSOrigin: *origin, Pace: *pace}).Handler()
	if err != nil {
		fmt.Fprintln(os.Stderr, "testserver:", err)
		os.Exit(1)
	}
	// Unencrypted HTTP/2 as well as HTTP/1.1, as a Connect server offers.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server := &http.Server{Addr: *addr, Handler: handler, Protocols: protocols, ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("testserver: http://%s\n", *addr)
	if err := server.ListenAndServe(); err != nil {
		fmt.Fprintln(os.Stderr, "testserver:", err)
		os.Exit(1)
	}
}
