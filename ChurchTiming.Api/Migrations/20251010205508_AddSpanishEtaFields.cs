using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChurchTiming.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddSpanishEtaFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "SpanishEtaUpdatedAtUtc",
                table: "Runs",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SpanishEtaUpdatedAtUtc",
                table: "Runs");
        }
    }
}
