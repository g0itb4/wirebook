// Package testserver is the API the end-to-end tests call: the fixture
// services over Connect and over REST, behind every authentication scheme
// the console offers.
//
// It is a fixture, not an example of a production server: its credentials
// are constants, written here and in the tests.
package testserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"connectrpc.com/vanguard"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	fixturev1 "github.com/g0itb4/wirebook/internal/testserver/gen/fixture/v1"
	"github.com/g0itb4/wirebook/internal/testserver/gen/fixture/v1/fixturev1connect"
)

// The credentials the server accepts. Any one of them is enough.
const (
	Token    = "test-token"
	Username = "ada"
	Password = "lovelace"
	APIKey   = "test-key"
	// KeyHeader and KeyParameter are where the API key may travel.
	KeyHeader    = "X-API-Key"
	KeyParameter = "key"
)

// Options configure the server.
type Options struct {
	// CORSOrigin is the origin allowed to call the API from a browser.
	// Empty: no CORS headers at all, as an API that was never meant to be
	// called from a page.
	CORSOrigin string
	// Pace is the wait between the messages of a stream.
	Pace time.Duration
}

// Server is the fixture API.
type Server struct {
	opts Options

	mu      sync.Mutex
	widgets map[string]*fixturev1.Widget
	seen    Seen
}

// Seen is what the server last accepted: the tests ask it which credential
// arrived, since a page cannot show that itself.
type Seen struct {
	// Scheme is "bearer", "basic", "api-key-header" or "api-key-query".
	Scheme string `json:"scheme"`
	// Path is the path of the request, as the server got it.
	Path string `json:"path"`
	// Count is how many requests were accepted.
	Count int `json:"count"`
}

// New returns a server with one widget, w1.
func New(opts Options) *Server {
	s := &Server{opts: opts, widgets: map[string]*fixturev1.Widget{}}
	s.widgets["w1"] = fixturev1.Widget_builder{
		Id:         proto.String("w1"),
		Quantity:   3,
		Serial:     proto.Int64(9007199254740993),
		Colour:     fixturev1.Colour_COLOUR_RED.Enum(),
		Tags:       []string{"first"},
		CreateTime: timestamppb.New(time.Date(2026, 10, 2, 3, 4, 5, 0, time.UTC)),
	}.Build()
	return s
}

// Handler serves the API: Connect, gRPC and REST on the same paths, an
// endpoint for the tests, and CORS when it is configured.
func (s *Server) Handler() (http.Handler, error) {
	widgets := vanguard.NewService(fixturev1connect.NewWidgetServiceHandler(widgetService{s}))
	library := vanguard.NewService(fixturev1connect.NewLibraryServiceHandler(libraryService{}))
	transcoder, err := vanguard.NewTranscoder([]*vanguard.Service{widgets, library})
	if err != nil {
		return nil, fmt.Errorf("testserver: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /_seen", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.seen)
	})
	mux.Handle("/", s.authenticated(transcoder))
	return s.cors(mux), nil
}

// cors answers the preflight and marks the responses, for one origin.
func (s *Server) cors(next http.Handler) http.Handler {
	if s.opts.CORSOrigin == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Add("Vary", "Origin")
		if r.Header.Get("Origin") == s.opts.CORSOrigin {
			header.Set("Access-Control-Allow-Origin", s.opts.CORSOrigin)
			header.Set("Access-Control-Expose-Headers", "Content-Type, Connect-Content-Encoding")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD")
				// What the console sends: the Connect headers, and each
				// scheme's own.
				header.Set("Access-Control-Allow-Headers", "Content-Type, Connect-Protocol-Version, Connect-Timeout-Ms, Authorization, "+KeyHeader)
				header.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// scheme names the credential of a request, or "" when it has none that the
// server accepts.
func scheme(r *http.Request) string {
	if token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && equal(token, Token) {
		return "bearer"
	}
	if username, password, ok := r.BasicAuth(); ok && equal(username, Username) && equal(password, Password) {
		return "basic"
	}
	if equal(r.Header.Get(KeyHeader), APIKey) {
		return "api-key-header"
	}
	if equal(r.URL.Query().Get(KeyParameter), APIKey) {
		return "api-key-query"
	}
	return ""
}

// authenticated refuses a request without a credential, in the shape of the
// protocol the request speaks.
func (s *Server) authenticated(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := scheme(r)
		if name == "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			message := "send a bearer token, basic credentials or an API key"
			if strings.HasPrefix(r.URL.Path, "/fixture.") {
				// A Connect error.
				_ = json.NewEncoder(w).Encode(map[string]any{"code": "unauthenticated", "message": message})
			} else {
				// A google.rpc.Status, as a REST gateway answers.
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 16, "message": message})
			}
			return
		}
		s.mu.Lock()
		s.seen = Seen{Scheme: name, Path: r.URL.EscapedPath(), Count: s.seen.Count + 1}
		s.mu.Unlock()

		// The key is the server's business, not a field of the request: the
		// REST transcoder would refuse a query parameter it does not know.
		query := r.URL.Query()
		if query.Has(KeyParameter) {
			query.Del(KeyParameter)
			r = r.Clone(r.Context())
			r.URL.RawQuery = query.Encode()
		}
		next.ServeHTTP(w, r)
	})
}

type widgetService struct{ s *Server }

func (w widgetService) GetWidget(_ context.Context, request *connect.Request[fixturev1.GetWidgetRequest]) (*connect.Response[fixturev1.GetWidgetResponse], error) {
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	widget, ok := w.s.widgets[request.Msg.GetId()]
	if !ok {
		err := connect.NewError(connect.CodeNotFound, fmt.Errorf("no widget %q", request.Msg.GetId()))
		// The request, as a detail: the console decodes it with the schema.
		if detail, detailErr := connect.NewErrorDetail(request.Msg); detailErr == nil {
			err.AddDetail(detail)
		}
		return nil, err
	}
	return connect.NewResponse(fixturev1.GetWidgetResponse_builder{Widget: widget}.Build()), nil
}

func (w widgetService) CreateWidget(_ context.Context, request *connect.Request[fixturev1.CreateWidgetRequest]) (*connect.Response[fixturev1.CreateWidgetResponse], error) {
	widget := request.Msg.GetWidget()
	if widget.GetId() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("a widget needs an id"))
	}
	w.s.mu.Lock()
	defer w.s.mu.Unlock()
	w.s.widgets[widget.GetId()] = widget
	return connect.NewResponse(fixturev1.CreateWidgetResponse_builder{Widget: widget}.Build()), nil
}

// WatchWidgets sends three widgets of the colour asked for. Asked for green,
// it fails after the first: a stream that ends with an error.
func (w widgetService) WatchWidgets(ctx context.Context, request *connect.Request[fixturev1.WatchWidgetsRequest], stream *connect.ServerStream[fixturev1.WatchWidgetsResponse]) error {
	colour := request.Msg.GetColour()
	for _, id := range []string{"a", "b", "c"} {
		widget := fixturev1.Widget_builder{Id: proto.String(id), Colour: colour.Enum()}.Build()
		if err := stream.Send(fixturev1.WatchWidgetsResponse_builder{Widget: widget}.Build()); err != nil {
			return err
		}
		if colour == fixturev1.Colour_COLOUR_GREEN {
			return connect.NewError(connect.CodeUnavailable, fmt.Errorf("the feed went away"))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(w.s.opts.Pace):
		}
	}
	return nil
}

type libraryService struct {
	fixturev1connect.UnimplementedLibraryServiceHandler
}

func (libraryService) GetBook(_ context.Context, request *connect.Request[fixturev1.GetBookRequest]) (*connect.Response[fixturev1.GetBookResponse], error) {
	return connect.NewResponse(&fixturev1.GetBookResponse{Book: &fixturev1.Book{
		Name:  proto.String(request.Msg.GetName()),
		Title: proto.String("The Dispossessed"),
		Pages: proto.Int32(341),
	}}), nil
}

// ListBooks answers with one book that says what the server understood of
// the request, so a test can see how the query was mapped.
func (libraryService) ListBooks(_ context.Context, request *connect.Request[fixturev1.ListBooksRequest]) (*connect.Response[fixturev1.ListBooksResponse], error) {
	msg := request.Msg
	return connect.NewResponse(&fixturev1.ListBooksResponse{
		Books: []*fixturev1.Book{{
			Name:   proto.String(msg.GetParent() + "/books/1"),
			Title:  proto.String(fmt.Sprintf("page_size=%d family_name=%s", msg.GetPageSize(), msg.GetFilter().GetFamilyName())),
			Genres: msg.GetGenres(),
		}},
	}), nil
}

func (libraryService) UpdateBook(_ context.Context, request *connect.Request[fixturev1.UpdateBookRequest]) (*connect.Response[fixturev1.UpdateBookResponse], error) {
	return connect.NewResponse(&fixturev1.UpdateBookResponse{Book: request.Msg.GetBook()}), nil
}
