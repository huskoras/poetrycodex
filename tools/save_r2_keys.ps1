# Saves the owner's Cloudflare R2 upload key for tools/sync_r2.py.
# Run it in your own terminal; it asks for the two values from the R2 "Create API token" page
# and stores them in your user environment. Nothing you paste is shown on screen.
$id = Read-Host "Paste the Access Key ID (32 characters), then press Enter" -AsSecureString
$sec = Read-Host "Paste the Secret Access Key (64 characters), then press Enter" -AsSecureString
function Plain($s) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
$idText = (Plain $id).Trim()
$secText = (Plain $sec).Trim()
if ($idText.Length -ne 32 -or $secText.Length -ne 64) {
    Write-Host "That does not look right: the Access Key ID should be 32 characters and the Secret 64. Nothing was saved; run this again." -ForegroundColor Yellow
    exit 1
}
[Environment]::SetEnvironmentVariable('R2_ACCESS_KEY_ID', $idText, 'User')
[Environment]::SetEnvironmentVariable('R2_SECRET_ACCESS_KEY', $secText, 'User')
Write-Host "Saved. You can tell Claude the keys are ready." -ForegroundColor Green
