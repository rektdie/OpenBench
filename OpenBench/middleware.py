from django.middleware.csrf import get_token


class EnsureCsrfCookieMiddleware:
    """
    RektBench's terminal turns every page into a place a POST can come
    from (`engine <name>`, any `--submit` form command, ...), not just the
    handful of templates that happen to render {% csrf_token %}. Django's
    default behaviour is to only set the csrftoken cookie on responses
    where get_token() was actually called while rendering the page, so a
    guest who lands on /index/ (no CSRF-tagged form on that page) and
    immediately runs `engine eleanor` has no cookie yet, and the POST is
    rejected with "CSRF cookie not set."

    Calling get_token(request) here unconditionally flags the request as
    needing the cookie, so CsrfViewMiddleware sets it on every response
    regardless of what the page itself renders.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        get_token(request)
        return self.get_response(request)
