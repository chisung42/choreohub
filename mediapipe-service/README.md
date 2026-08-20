# ChoreoHub MediaPipe service

This service receives an uploaded source video, samples MediaPipe Pose world
landmarks, and returns the motion data that ChoreoHub associates with a version.
It does not perform similarity or copyright decisions.

```bash
cd mediapipe-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

Set the mobile app's `EXPO_PUBLIC_MEDIAPIPE_API_URL` to the reachable HTTPS URL
of this service. For a physical phone, `localhost` means the phone itself; use
your computer's LAN address during development or deploy the service.
