#!/bin/bash
# Adapted from electron-builder 26.8.1 linux/after-remove.tpl (MIT).

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  rm -f "$APPARMOR_PROFILE_DEST"
fi


# Keep the managed helper profile during a package upgrade. On removal, retain
# foreign or edited profiles; only our complete exact current bytes may retire.
case "$1" in
  remove|purge)
    DAC_HELPER='/opt/${sanitizedProductName}/resources/app.asar.unpacked/out/main/chunks/deepagent-work-process-supervisor'
    DAC_ID=$(printf '%s' "$DAC_HELPER" | sha256sum | cut -c1-32)
    DAC_NAME="dac_work_$DAC_ID"
    DAC_PROFILE="/etc/apparmor.d/$DAC_NAME"
    DAC_EXPECTED=$(printf '# DAC managed command namespace: exact packaged supervisor only.\nabi <abi/4.0>,\nprofile %s "%s" flags=(unconfined) {\n  userns,\n}\n' "$DAC_NAME" "$DAC_HELPER" | sha256sum | cut -c1-64)
    DAC_DIRECTORY_SAFE=false
    if [ "$(readlink -f /etc/apparmor.d)" = /etc/apparmor.d ] && [ "$(stat -c %u /etc/apparmor.d)" = 0 ] && [ "$((0$(stat -c %a /etc/apparmor.d) & 022))" = 0 ]; then
      DAC_DIRECTORY_SAFE=true
    fi
    if [ "$DAC_DIRECTORY_SAFE" = true ] && [ -f "$DAC_PROFILE" ] && [ ! -L "$DAC_PROFILE" ] && [ "$(stat -c %u "$DAC_PROFILE")" = 0 ] && [ "$(stat -c %h "$DAC_PROFILE")" = 1 ] && [ "$((0$(stat -c %a "$DAC_PROFILE") & 022))" = 0 ] && [ "$(sha256sum "$DAC_PROFILE" | cut -c1-64)" = "$DAC_EXPECTED" ]; then
      if /usr/sbin/apparmor_parser --remove "$DAC_PROFILE"; then
        rm -- "$DAC_PROFILE"
      else
        echo "DAC_APPARMOR_RETIRE_UNKNOWN: retained $DAC_PROFILE" >&2
      fi
    elif [ -e "$DAC_PROFILE" ] || [ -L "$DAC_PROFILE" ]; then
      echo "DAC_APPARMOR_FOREIGN_PROFILE: retained $DAC_PROFILE" >&2
    fi
    ;;
esac
