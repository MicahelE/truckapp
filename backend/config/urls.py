from django.urls import path

from routing import views

urlpatterns = [
    path("api/geocode", views.geocode),
    path("api/routes", views.routes),
]
