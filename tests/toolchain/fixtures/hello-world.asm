bits 64

global _start

section .text
_start:
    mov eax, 1
    mov edi, 1
    mov esi, message
    mov edx, message_len
    syscall

    mov eax, 60
    xor edi, edi
    syscall

section .rodata
message: db "hello from nasm", 10
message_len equ $ - message
