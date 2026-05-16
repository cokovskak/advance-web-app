# Starts the PWA backend and ngrok tunnel in separate windows.
# Usage:  .\start.ps1 -Domain your-static-domain.ngrok-free.app
# If you skip -Domain it uses plain ngrok (URL changes every restart).

param(
  [string]$Domain = ""
)

$appDir = $PSScriptRoot

# Start the Node backend in a new window
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$appDir'; npm start"

Start-Sleep -Seconds 2

# Start ngrok
if ($Domain) {
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "ngrok http --domain=$Domain 8080"
  Write-Host ""
  Write-Host "Backend : http://localhost:8080"
  Write-Host "Public  : https://$Domain"
  Write-Host ""
  Write-Host "Add this to your GitHub repo secrets:"
  Write-Host "  BACKEND_URL = https://$Domain"
} else {
  Start-Process powershell -ArgumentList "-NoExit", "-Command", "ngrok http 8080"
  Write-Host ""
  Write-Host "Backend : http://localhost:8080"
  Write-Host "Public  : check the ngrok window for the https:// URL"
  Write-Host ""
  Write-Host "Tip: get a free static domain at ngrok.com/dashboard so the URL never changes."
}
